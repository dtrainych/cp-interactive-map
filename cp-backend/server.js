require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const { createLogger, format, transports } = require('winston');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// Initialize logger
const logger = createLogger({
    level: 'info',
    format: format.combine(
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}]: ${message}`)
    ),
    transports: [
        new transports.Console(),
        new transports.File({ filename: 'server.log' })
    ]
});

// Initialize Express app
const app = express();
// configure proxy rate limit
app.set('trust proxy', 1 /* number of proxies between user and server */)
// Middleware setup
app.use(cors({ origin: new RegExp(process.env.CORS_ORIGIN) || 'http://localhost:5173' }));
app.use(express.json());
app.use(helmet());
app.use(rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200 // 200 requests per IP
}));
app.get('/api/ip', (request, response) => response.send(request.ip));

// Constants
const ACTIVE_STATUSES = ['IN_TRANSIT', 'AT_STATION'];
const CACHE_FILE_PATH = path.join(__dirname, process.env.CACHE_FILE || 'data/cache.json');
const DEFAULT_PORT = 3000;

// Cache management
const trainCache = new Map();
let trainsData = [];
let cacheRefreshQueue = [];
let isRefreshInProgress = false;
const REFRESH_BATCH_SIZE = 25;
const REFRESH_BATCH_INTERVAL = 500; // 500ms between batches
const CACHE_REFRESH_INTERVAL = 60 * 1000; // 1 minute

// Load static train data from JSON file
async function loadTrainsData() {
    try {
        const filePath = path.join(__dirname, 'data/trains.json');
        const data = await fs.readFile(filePath, 'utf8');
        trainsData = JSON.parse(data);
        logger.info(`Loaded ${trainsData.length} trains from trains.json`);
    } catch (error) {
        logger.error(`Error loading trains data: ${error.message}`);
        trainsData = [];
    }
}

// Load cache from file
async function loadCacheFromFile() {
    try {
        const data = await fs.readFile(CACHE_FILE_PATH, 'utf8');
        const cachedData = JSON.parse(data);
        const now = Date.now();
        trainCache.clear();

        for (const [trainId, entry] of Object.entries(cachedData)) {
            if (entry.timestamp && entry.ttl) {
                // Load all entries regardless of TTL, but mark them for refresh if needed
                trainCache.set(Number(trainId), entry);
                if (now - entry.timestamp >= entry.ttl) {
                    // Add to refresh queue if expired
                    queueTrainForRefresh(Number(trainId));
                    logger.info(`Train ${trainId} loaded from cache but expired - queued for refresh`);
                } else {
                    logger.info(`Restored train ${trainId} from cache - TTL remaining: ${((entry.timestamp + entry.ttl - now) / 1000).toFixed(1)}s`);
                }
            }
        }
        logger.info(`Loaded ${trainCache.size} entries from cache, ${cacheRefreshQueue.length} queued for refresh`);
    } catch (error) {
        logger.info(error.code === 'ENOENT' ? 'No cache file found, starting fresh' : `Error loading cache: ${error.message}`);
    }
}

// Save cache to file
async function saveCacheToFile() {
    try {
        const cacheObject = Object.fromEntries(trainCache);
        await fs.writeFile(CACHE_FILE_PATH, JSON.stringify(cacheObject, null, 2), 'utf8');
        logger.info(`Saved ${trainCache.size} trains to cache`);
    } catch (error) {
        logger.error(`Error saving cache: ${error.message}`);
    }
}

// Queue a train for refresh
function queueTrainForRefresh(trainId, priority = false) {
    // Skip if already in queue
    if (cacheRefreshQueue.includes(trainId)) return;
    
    // Add to queue (at beginning if priority)
    if (priority) {
        cacheRefreshQueue.unshift(trainId);
    } else {
        cacheRefreshQueue.push(trainId);
    }
    
    // Start refresh process if not already running
    if (!isRefreshInProgress) {
        processRefreshQueue();
    }
}

// Process the refresh queue
async function processRefreshQueue() {
    if (cacheRefreshQueue.length === 0 || isRefreshInProgress) return;
    
    isRefreshInProgress = true;
    logger.info(`Starting refresh of ${cacheRefreshQueue.length} trains`);
    
    try {
        while (cacheRefreshQueue.length > 0) {
            // Process in batches
            const batchSize = Math.min(REFRESH_BATCH_SIZE, cacheRefreshQueue.length);
            const batch = cacheRefreshQueue.splice(0, batchSize);
            
            await Promise.all(batch.map(async trainId => {
                const data = await fetchTrainFromCP(trainId);
                if (data) {
                    const ttl = calculateTTL(data);
                    trainCache.set(trainId, { data, timestamp: Date.now(), ttl });
                    logger.info(`Refreshed train ${trainId} - TTL: ${ttl / 1000}s`);
                }
            }));
            
            // Wait between batches to avoid rate limiting
            if (cacheRefreshQueue.length > 0) {
                await new Promise(resolve => setTimeout(resolve, REFRESH_BATCH_INTERVAL));
            }
        }
        
        await saveCacheToFile();
        logger.info('Refresh queue processed successfully');
    } catch (error) {
        logger.error(`Error processing refresh queue: ${error.message}`);
    } finally {
        isRefreshInProgress = false;
    }
}

// Fetch train data from CP API
async function fetchTrainFromCP(trainId) {
    const url = `https://www.cp.pt/sites/spring/station/trains/train?trainId=${trainId}`;
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`CP API returned ${response.status}`);
        return await response.json();
    } catch (error) {
        logger.error(`Error fetching train ${trainId}: ${error.message}`);
        return null;
    }
}

// Calculate TTL based on train status
function calculateTTL(train) {
    const status = (train.status || 'UNKNOWN').toUpperCase();
    const now = new Date();
    const currentTimeInMinutes = now.getHours() * 60 + now.getMinutes();

    switch (status) {
        case 'IN_TRANSIT': return 5 * 1000; // 5 seconds
        case 'AT_STATION': return 30 * 1000; // 30 seconds
        case 'NEAR_NEXT': return 30 * 1000; // 30 seconds
        case 'AT_ORIGIN': return 60 * 1000; // 60 seconds
        default:
            if (train.trainStops?.length) {
                const nextStop = train.trainStops.find(stop => {
                    const eta = stop.eta || stop.arrival || stop.departure;
                    return eta && parseTime(eta) > currentTimeInMinutes;
                });
                if (nextStop) {
                    const etaMinutes = parseTime(nextStop.eta || nextStop.arrival || nextStop.departure);
                    const timeUntilNextStop = (etaMinutes - currentTimeInMinutes) * 60 * 1000;
                    return Math.max(timeUntilNextStop - 60 * 1000, 5 * 60 * 1000);
                }
            }
            return 5 * 60 * 1000; // Default 5 minutes
    }
}

// Parse time string to minutes
function parseTime(timeStr) {
    const [hours, minutes] = timeStr.split(':').map(Number);
    return hours * 60 + minutes;
}

// Periodic cache refresh to prevent mass expiration
function schedulePeriodicRefresh() {
    setInterval(() => {
        const now = Date.now();
        const soonToExpire = [];
        const EXPIRATION_THRESHOLD = 60 * 1000; // 1 minute
        
        // Find trains that will expire soon
        trainCache.forEach((entry, trainId) => {
            const timeUntilExpiry = entry.timestamp + entry.ttl - now;
            if (timeUntilExpiry < EXPIRATION_THRESHOLD && timeUntilExpiry > 0) {
                soonToExpire.push(trainId);
            }
        });
        
        if (soonToExpire.length > 0) {
            logger.info(`Scheduling refresh for ${soonToExpire.length} trains expiring soon`);
            soonToExpire.forEach(trainId => queueTrainForRefresh(trainId));
        }
        
        // Also refresh some inactive trains
        const inactiveTrains = [];
        trainsData.forEach(train => {
            const trainId = Number(train.trainNumber);
            if (!trainCache.has(trainId) || trainCache.get(trainId).timestamp + trainCache.get(trainId).ttl < now) {
                inactiveTrains.push(trainId);
            }
        });
        
        if (inactiveTrains.length > 0) {
            // Refresh a portion of inactive trains each cycle
            const toRefresh = inactiveTrains.slice(0, Math.min(20, inactiveTrains.length));
            logger.info(`Scheduling refresh for ${toRefresh.length} inactive trains`);
            toRefresh.forEach(trainId => queueTrainForRefresh(trainId));
        }
    }, CACHE_REFRESH_INTERVAL);
}

// Initialize train cache with progressive loading
async function initializeTrainCache() {
    logger.info('Initializing train cache with progressive loading');
    
    // Start with a small batch of trains for immediate availability
    const highPriorityTrains = trainsData.slice(0, 50);
    
    // Queue all trains for refresh, with high priority trains first
    highPriorityTrains.forEach(train => queueTrainForRefresh(Number(train.trainNumber), true));
    
    // Queue the rest
    trainsData.slice(50).forEach(train => queueTrainForRefresh(Number(train.trainNumber)));
    
    // Start processing the queue
    await processRefreshQueue();
}

// Get train data, potentially from cache
async function getTrainData(trainId) {
    const now = Date.now();
    const cached = trainCache.get(trainId);
    
    // Return cached data if valid
    if (cached && (now - cached.timestamp) < cached.ttl) {
        return cached.data;
    }
    
    // Return stale data but queue for refresh
    if (cached) {
        queueTrainForRefresh(trainId, true);
        return cached.data;
    }
    
    // Fetch fresh data if not in cache
    const data = await fetchTrainFromCP(trainId);
    if (data) {
        const ttl = calculateTTL(data);
        trainCache.set(trainId, { data, timestamp: now, ttl });
        logger.info(`Fetched train ${trainId} - TTL: ${ttl / 1000}s`);
    }
    return data;
}

// API Endpoints

/** GET /api/train/:trainId - Fetch individual train details */
app.get('/api/train/:trainId', async (req, res) => {
    const trainId = req.params.trainId ? Number(req.params.trainId) : null;
    if (!trainId || isNaN(trainId)) {
        return res.status(400).json({ error: 'Invalid trainId' });
    }
    
    try {
        const data = await getTrainData(trainId);
        if (!data) throw new Error('No data from CP API');
        res.json(data);
    } catch (error) {
        logger.error(`Error fetching train ${trainId}: ${error.message}`);
        res.status(500).json({ error: 'Failed to fetch train data' });
    }
});

/** GET /api/trains/in-transit - Fetch all in-transit trains */
app.get('/api/trains/in-transit', async (req, res) => {
    try {
        // Use cached data first, even if slightly stale
        const allTrains = await Promise.all(trainsData.map(async train => {
            const trainId = Number(train.trainNumber);
            const data = await getTrainData(trainId);
            return data;
        }));
        
        // Filter only in-transit trains
        const inTransitTrains = allTrains
            .filter(Boolean)
            .filter(train => ACTIVE_STATUSES.includes((train.status || '').toUpperCase()));
        
        logger.info(`Serving ${inTransitTrains.length} in-transit trains`);
        res.json({ total: inTransitTrains.length, trains: inTransitTrains });
    } catch (error) {
        logger.error(`Error in in-transit endpoint: ${error.message}`);
        res.status(500).json({ error: 'Failed to fetch in-transit trains' });
    }
});

/** GET /api/trains/metrics - Fetch train metrics */
app.get('/api/trains/metrics', async (req, res) => {
    const now = Date.now();
    try {
        const allTrains = await Promise.all(trainsData.map(async train => {
            const trainId = Number(train.trainNumber);
            return await getTrainData(trainId) || train;
        }));
        
        const validTrains = allTrains.filter(Boolean);
        const metrics = calculateMetrics(validTrains, now);
        logger.info(`Serving metrics: ${JSON.stringify(metrics)}`);
        res.json(metrics);
    } catch (error) {
        logger.error(`Error in metrics endpoint: ${error.message}`);
        res.status(500).json({ error: 'Failed to fetch train metrics' });
    }
});

// Helper function to calculate metrics
function calculateMetrics(trains, now) {
    const statusCounts = {};
    const serviceCounts = {};
    let cachedCount = 0;
    let totalDelay = 0;
    let delayedTrains = 0;

    trains.forEach(train => {
        const status = (train.status || 'UNKNOWN').toUpperCase();
        const service = (train.serviceCode?.code || 'UNKNOWN').toUpperCase();
        statusCounts[status] = (statusCounts[status] || 0) + 1;
        serviceCounts[service] = (serviceCounts[service] || 0) + 1;

        if (trainCache.get(train.trainNumber)?.timestamp + trainCache.get(train.trainNumber)?.ttl > now) cachedCount++;
        if (train.delay > 0) {
            totalDelay += train.delay;
            delayedTrains++;
        }
    });

    return {
        totalTrains: trains.length,
        statusBreakdown: statusCounts,
        serviceBreakdown: serviceCounts,
        cachedTrains: cachedCount,
        cacheHitRate: trains.length ? `${(cachedCount / trains.length * 100).toFixed(2)}%` : '0%',
        activeTrains: (statusCounts['IN_TRANSIT'] || 0) + (statusCounts['AT_STATION'] || 0),
        averageDelay: delayedTrains ? `${(totalDelay / delayedTrains).toFixed(2)} min` : 'N/A',
        queueSize: cacheRefreshQueue.length,
        refreshInProgress: isRefreshInProgress
    };
}

/** GET /api/cache/status - View cache status */
app.get('/api/cache/status', (req, res) => {
    const now = Date.now();
    const status = {
        totalCached: trainCache.size,
        validCache: 0,
        expiredCache: 0,
        queueSize: cacheRefreshQueue.length,
        refreshInProgress: isRefreshInProgress
    };
    
    trainCache.forEach((entry) => {
        if (now - entry.timestamp < entry.ttl) {
            status.validCache++;
        } else {
            status.expiredCache++;
        }
    });
    
    res.json(status);
});

/** POST /api/cache/refresh - Manually trigger cache refresh */
app.post('/api/cache/refresh', (req, res) => {
    const { trainId } = req.body;
    
    if (trainId) {
        if (isNaN(Number(trainId))) {
            return res.status(400).json({ error: 'Invalid trainId' });
        }
        queueTrainForRefresh(Number(trainId), true);
        res.json({ message: `Train ${trainId} queued for refresh` });
    } else {
        // Queue all trains for refresh
        trainsData.forEach(train => queueTrainForRefresh(Number(train.trainNumber)));
        res.json({ message: `All trains queued for refresh` });
    }
});

// Centralized error handling
app.use((err, req, res, next) => {
    logger.error(`Unhandled error on ${req.method} ${req.path}: ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Internal Server Error' });
});

// Start server
const PORT = process.env.PORT || DEFAULT_PORT;
app.listen(PORT, async () => {
    await loadTrainsData();
    await loadCacheFromFile();
    await initializeTrainCache();
    schedulePeriodicRefresh();
    logger.info(`Server running on http://localhost:${PORT}`);
});

// Periodic cache save and graceful shutdown
setInterval(saveCacheToFile, 5 * 60 * 1000); // Every 5 minutes
process.on('SIGINT', async () => {
    await saveCacheToFile();
    logger.info('Server shutting down');
    process.exit(0);
});