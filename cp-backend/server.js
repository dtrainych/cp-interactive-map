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

// Middleware setup
app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:5173' }));
app.use(express.json());
app.use(helmet());
app.use(rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // 100 requests per IP
}));

// Constants
const ACTIVE_STATUSES = ['IN_TRANSIT', 'AT_STATION'];
const CACHE_FILE_PATH = path.join(__dirname, process.env.CACHE_FILE || 'cache.json');
const DEFAULT_PORT = 3000;

// In-memory cache
const trainCache = new Map();
let trainsData = [];

// Load static train data from JSON file
async function loadTrainsData() {
    try {
        const filePath = path.join(__dirname, 'trains.json');
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
            if (entry.timestamp && entry.ttl && now - entry.timestamp < entry.ttl) {
                trainCache.set(trainId, entry);
                logger.info(`Restored train ${trainId} from cache - TTL remaining: ${((entry.timestamp + entry.ttl - now) / 1000).toFixed(1)}s`);
            }
        }
        logger.info(`Loaded ${trainCache.size} valid entries from cache`);
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
        case 'AT_ORIGIN': return 60 * 1000; // 30 seconds
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

// Initialize train cache with batching
async function initializeTrainCache() {
    logger.info('Initializing train cache with batching');
    const now = Date.now();
    const batchSize = 50;
    const delayBetweenBatches = 1000;

    const trainsToFetch = trainsData.filter(train => {
        const cached = trainCache.get(train.trainNumber);
        return !cached || (now - cached.timestamp >= cached.ttl);
    });

    if (!trainsToFetch.length) {
        logger.info('All trains cached and valid');
        return;
    }

    for (let i = 0; i < trainsToFetch.length; i += batchSize) {
        const batch = trainsToFetch.slice(i, i + batchSize);
        await Promise.all(batch.map(async train => {
            const trainId = train.trainNumber;
            const data = await fetchTrainFromCP(trainId);
            if (data) {
                const ttl = calculateTTL(data);
                trainCache.set(trainId, { data, timestamp: now, ttl });
                logger.info(`Cached train ${trainId} - TTL: ${ttl / 1000}s`);
            }
        }));
        if (i + batchSize < trainsToFetch.length) {
            await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
        }
    }
    await saveCacheToFile();
    logger.info(`Initialized cache with ${trainCache.size} trains`);
}

// API Endpoints

/** GET /api/train/:trainId - Fetch individual train details */
app.get('/api/train/:trainId', async (req, res) => {
    const { trainId } = req.params;
    if (!trainId || typeof trainId !== 'string' || !trainId.trim()) {
        return res.status(400).json({ error: 'Invalid trainId' });
    }

    const now = Date.now();
    const cached = trainCache.get(trainId);

    if (cached && (now - cached.timestamp) < cached.ttl) {
        logger.info(`Cache hit for train ${trainId}`);
        return res.json(cached.data);
    }

    try {
        const data = await fetchTrainFromCP(trainId);
        if (!data) throw new Error('No data from CP API');
        const ttl = calculateTTL(data);
        trainCache.set(trainId, { data, timestamp: now, ttl });
        logger.info(`Fetched train ${trainId} - TTL: ${ttl / 1000}s`);
        res.json(data);
    } catch (error) {
        logger.error(`Error fetching train ${trainId}: ${error.message}`);
        res.status(500).json({ error: 'Failed to fetch train data' });
    }
});

/** GET /api/trains/in-transit - Fetch all in-transit trains */
app.get('/api/trains/in-transit', async (req, res) => {
    const now = Date.now();
    try {
        const results = await Promise.all(trainsData.map(async train => {
            const trainId = train.trainNumber;
            const cached = trainCache.get(trainId);

            if (cached && (now - cached.timestamp) < cached.ttl) {
                return ACTIVE_STATUSES.includes(cached.data.status?.toUpperCase()) ? cached.data : null;
            }

            const data = await fetchTrainFromCP(trainId);
            if (data) {
                const ttl = calculateTTL(data);
                trainCache.set(trainId, { data, timestamp: now, ttl });
                return ACTIVE_STATUSES.includes(data.status?.toUpperCase()) ? data : null;
            }
            return null;
        }));

        const inTransitTrains = results.filter(Boolean);
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
            const trainId = train.trainNumber;
            const cached = trainCache.get(trainId);

            if (cached && (now - cached.timestamp) < cached.ttl) return cached.data;

            const data = await fetchTrainFromCP(trainId);
            if (data) {
                const ttl = calculateTTL(data);
                trainCache.set(trainId, { data, timestamp: now, ttl });
                return data;
            }
            return train;
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
    let cachedCount = 0;
    let totalDelay = 0;
    let delayedTrains = 0;

    trains.forEach(train => {
        const status = (train.status || 'UNKNOWN').toUpperCase();
        statusCounts[status] = (statusCounts[status] || 0) + 1;

        if (trainCache.get(train.trainNumber)?.timestamp + trainCache.get(train.trainNumber)?.ttl > now) cachedCount++;
        if (train.delay > 0) {
            totalDelay += train.delay;
            delayedTrains++;
        }
    });

    return {
        totalTrains: trains.length,
        statusBreakdown: statusCounts,
        cachedTrains: cachedCount,
        cacheHitRate: trains.length ? `${(cachedCount / trains.length * 100).toFixed(2)}%` : '0%',
        activeTrains: (statusCounts['IN_TRANSIT'] || 0) + (statusCounts['AT_STATION'] || 0),
        averageDelay: delayedTrains ? `${(totalDelay / delayedTrains).toFixed(2)} min` : 'N/A'
    };
}

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
    logger.info(`Server running on http://localhost:${PORT}`);
});

// Periodic cache save and graceful shutdown
setInterval(saveCacheToFile, 5 * 60 * 1000); // Every 5 minutes
process.on('SIGINT', async () => {
    await saveCacheToFile();
    logger.info('Server shutting down');
    process.exit(0);
});