// Required type definitions
import { config } from 'dotenv';
import express, { NextFunction, request, Request, Response } from 'express';
import cors from 'cors';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger, format, transports } from 'winston';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import jsonTrains from './data/trains.json';
import jsonCache from './data/cache.json';

interface TrainStation {
  code: string;
  designation: string;
}
interface TrainService {
  code: string;
  designation: string;
}

// Type definitions
interface TrainStop {
  station: TrainStation;
  stationId: string;
  stationName?: string;
  arrival?: string;
  departure?: string;
  eta?: string;
  platform?: string;
}

interface Train {
  trainNumber: number;
  trainId?: number; // Some APIs might use this instead
  status?: string;
  serviceCode?: {
    code: string;
    name?: string;
  };
  delay?: number;
  trainStops?: TrainStop[];
  [key: string]: any; // For other properties we might not know about
}

interface Station {
  delay: number;
  trainOrigin: TrainStation;
  trainDestination: TrainStation;
  departureTime?: string;
  arrivalTime?: string;
  trainNumber: number;
  trainService: TrainService;
  platform?: string;
  occupancy?: number;
  eta?: string;
  etd?: string;
}

interface TrainCacheEntry {
  data: Train;
  timestamp: number;
  ttl: number;
}
interface StationCacheEntry {
  data: Station;
  timestamp: number;
  ttl: number;
}

interface CoordsCacheEntry {
  data: string;
  timestamp: number;
  ttl: number;
}

// Load environment variables
config();

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

function stringToHash(string: String) {
  let hash = 0;
  if (string.length == 0) return hash;
  let i = 0;
  let char = 0;
  for (i = 0; i < string.length; i++) {
    char = string.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash;
}


// Initialize Express app
const app = express();
// Configure proxy rate limit
app.set('trust proxy', 1 /* number of proxies between user and server */);
// Middleware setup
app.use(cors({
  origin: process.env.CORS_ORIGIN ? new RegExp(process.env.CORS_ORIGIN) : 'http://localhost:5173'
}));
app.use(express.json());
app.use(helmet());
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200 // 200 requests per IP
}));

// Constants
const ACTIVE_STATUSES: string[] = ['IN_TRANSIT', 'AT_STATION', 'NEAR_NEXT', 'AT_ORIGIN'];
const CACHE_FILE_PATH: string = path.join(__dirname, process.env.CACHE_FILE || 'data/cache.json');
const DEFAULT_PORT: number = 3000;

// Cache management
const trainCache: Map<number, TrainCacheEntry> = new Map();
const stationCache: Map<string, StationCacheEntry> = new Map();
const coordsCache: Map<number, CoordsCacheEntry> = new Map();
let trainsData: Train[] = [];
let cacheRefreshQueue: number[] = [];
let isRefreshInProgress: boolean = false;
const REFRESH_BATCH_SIZE: number = 25;
const REFRESH_BATCH_INTERVAL: number = 500; // 500ms between batches
const CACHE_REFRESH_INTERVAL: number = 60 * 1000; // 1 minute

// Load static train data from JSON file
async function loadTrainsData(): Promise<void> {
  try {
    const filePath = path.join(__dirname, 'data/trains.json');
    const data = await fs.readFile(filePath, 'utf8');
    trainsData = JSON.parse(data);
    logger.info(`Loaded ${trainsData.length} trains from trains.json`);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error loading trains data: ${err.message}`);
    trainsData = [];
  }
}

// Load cache from file
async function loadCacheFromFile(): Promise<void> {
  try {
    const data = await fs.readFile(CACHE_FILE_PATH, 'utf8');
    const cachedData = JSON.parse(data);
    const now = Date.now();
    trainCache.clear();

    for (const [trainIdStr, entry] of Object.entries(cachedData)) {
      const trainId = Number(trainIdStr);
      const TrainCacheEntry = entry as TrainCacheEntry;

      if (TrainCacheEntry.timestamp && TrainCacheEntry.ttl) {
        // Load all entries regardless of TTL, but mark them for refresh if needed
        trainCache.set(trainId, TrainCacheEntry);
        if (now - TrainCacheEntry.timestamp >= TrainCacheEntry.ttl) {
          // Add to refresh queue if expired
          queueTrainForRefresh(trainId);
          logger.info(`Train ${trainId} loaded from cache but expired - queued for refresh`);
        } else {
          logger.info(`Restored train ${trainId} from cache - TTL remaining: ${((TrainCacheEntry.timestamp + TrainCacheEntry.ttl - now) / 1000).toFixed(1)}s`);
        }
      }
    }
    logger.info(`Loaded ${trainCache.size} entries from cache, ${cacheRefreshQueue.length} queued for refresh`);
  } catch (error) {
    const err = error as Error;
    logger.info(err.message === 'ENOENT' ? 'No cache file found, starting fresh' : `Error loading cache: ${err.message}`);
  }
}

// Save cache to file
async function saveCacheToFile(): Promise<void> {
  try {
    // Convert Map to an object with string keys for JSON serialization
    const cacheObject: Record<string, TrainCacheEntry> = {};
    trainCache.forEach((value, key) => {
      cacheObject[key.toString()] = value;
    });

    await fs.writeFile(CACHE_FILE_PATH, JSON.stringify(cacheObject, null, 2), 'utf8');
    logger.info(`Saved ${trainCache.size} trains to cache`);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error saving cache: ${err.message}`);
  }
}

// Queue a train for refresh
function queueTrainForRefresh(trainId: number, priority: boolean = false): void {
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
async function processRefreshQueue(): Promise<void> {
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
    const err = error as Error;
    logger.error(`Error processing refresh queue: ${err.message}`);
  } finally {
    isRefreshInProgress = false;
  }
}

// Fetch train data from CP API
async function fetchTrainFromCP(trainId: number): Promise<Train | null> {
  const url = `https://www.cp.pt/sites/spring/station/trains/train?trainId=${trainId}`;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`CP API returned ${response.status}`);
    return await response.json();
  } catch (error) {
    const err = error as Error;
    logger.error(`Error fetching train ${trainId}: ${err.message}`);
    return null;
  }
}
// Fetch station data from CP API
async function fetchStationFromCP(stationId: string): Promise<Station | null> {
  const url = `https://www.cp.pt/sites/spring/station/trains?stationId=${stationId}`;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`CP API returned ${response.status}`);
    return await response.json();
  } catch (error) {
    const err = error as Error;
    logger.error(`Error fetching station ${stationId}: ${err.message}`);
    return null;
  }
}

// Calculate TTL based on train status
function calculateTTL(train: Train): number {
  const status = (train.status || 'UNKNOWN').toUpperCase();
  const now = new Date();
  const currentTimeInMinutes = now.getHours() * 60 + now.getMinutes();

  switch (status) {
    case 'IN_TRANSIT': return 10 * 1000; // 10 seconds
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
          const etaMinutes = parseTime(nextStop.eta || nextStop.arrival || nextStop.departure || '');
          const timeUntilNextStop = (etaMinutes - currentTimeInMinutes) * 60 * 1000;
          return Math.max(timeUntilNextStop - 60 * 1000, 5 * 60 * 1000);
        }
      }
      return 5 * 60 * 1000; // Default 5 minutes
  }
}

// Parse time string to minutes
function parseTime(timeStr: string): number {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}

// Periodic cache refresh to prevent mass expiration
function schedulePeriodicRefresh(): void {
  setInterval(() => {
    const now = Date.now();
    const soonToExpire: number[] = [];
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
    const inactiveTrains: number[] = [];
    trainsData.forEach(train => {
      const trainId = Number(train.trainNumber);
      const cached = trainCache.get(trainId);
      if (!cached || cached.timestamp + cached.ttl < now) {
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
async function initializeTrainCache(): Promise<void> {
  logger.info('Initializing train cache with progressive loading');
  const now = Date.now();

  // Queue only expired trains (or a subset)
  trainCache.forEach((entry, trainId) => {
    if (now - entry.timestamp >= entry.ttl) {
      queueTrainForRefresh(trainId);
    }
  });

  // Optionally, queue the first 50 as high-priority if still desired
  const highPriorityTrains = trainsData.slice(0, 50);
  highPriorityTrains.forEach(train => {
    const trainId = Number(train.trainNumber);
    if (!trainCache.get(trainId) || now - (trainCache.get(trainId)?.timestamp || 0) >= (trainCache.get(trainId)?.ttl || 0)) {
      queueTrainForRefresh(trainId, true);
    }
  });

  await processRefreshQueue();
}
// Get train data from cache (used for bulk endpoints)
function getCachedTrainData(trainId: number): Train | null {
  const cached = trainCache.get(trainId);
  if (!cached) return null;

  // If expired, queue for refresh but still return the data
  const now = Date.now();
  if (now - cached.timestamp >= cached.ttl) {
    queueTrainForRefresh(trainId);
  }

  return cached.data;
}
// Get station data
async function getStationData(stationId: string): Promise<Station | null> {
  const cached = stationCache.get(stationId);
  const now = Date.now();
  if (!cached || now - cached.timestamp >= cached.ttl) {
    const station = await fetchStationFromCP(stationId);
    if (!station) throw new Error('No data from CP API');

    const ttl = 30000; // 30 seconds
    stationCache.set(stationId, { data: station, timestamp: Date.now(), ttl });
    logger.info(`Fetched fresh data for station ${stationId} - TTL: ${ttl / 1000}s`);
    return station;

  }
  return cached.data;
}

// API Endpoints

/** GET /api/train/:trainId - Fetch individual train details (always fresh) */
app.get('/api/train/:trainId', async (req: Request, res: Response) => {
  const trainIdParam = req.params.trainId;
  const trainId = trainIdParam ? Number(trainIdParam) : null;

  if (!trainId || isNaN(trainId)) {
    res.status(400).json({ error: 'Invalid trainId' });
    return;
  }

  const now = Date.now();
  const cached = trainCache.get(trainId);

  // Return valid cached data if available
  if (cached && (now - cached.timestamp) < cached.ttl) {
    logger.info(`Cache hit for train ${trainId}`);
    res.json(cached.data);
    return
  }

  // Otherwise fetch fresh data
  try {
    const data = await fetchTrainFromCP(trainId);
    if (!data) throw new Error('No data from CP API');

    // Update cache
    const ttl = calculateTTL(data);
    trainCache.set(trainId, { data, timestamp: now, ttl });
    logger.info(`Fetched fresh data for train ${trainId} - TTL: ${ttl / 1000}s`);

    res.json(data);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error fetching train ${trainId}: ${err.message}`);

    // Fall back to stale cache if available and API call failed
    if (cached) {
      logger.info(`Falling back to stale cache for train ${trainId}`);
      res.json(cached.data);
      return
    }

    res.status(500).json({ error: 'Failed to fetch train data' });
  }
});

/** GET /api/trains/active - Fetch all active trains */
app.get('/api/trains/active', async (req: Request, res: Response) => {
  const { stationId } = req.query;
  try {
    let trains: Train[] = [];
    console.log(stationId)
    if (stationId && typeof stationId === "string" && stationId !== '') {

      console.log('getting station')
      const stationData = await getStationData(stationId);
      if (!stationData) { res.status(404).json({ error: 'Station Not Found' }); return; }

      trains = Object.values(stationData).map(train => {
        const trainId = Number(train.trainNumber);
        return getCachedTrainData(trainId);
      }).filter(Boolean) as Train[];
    } else {
      // Use cached data (even if stale) to provide fast response
      trains = trainsData.map(train => {
        const trainId = Number(train.trainNumber);
        return getCachedTrainData(trainId);
      }).filter(Boolean) as Train[];
    }

    // Filter only active trains
    const activeTrains = trains.filter(train =>
      ACTIVE_STATUSES.includes((train.status || '').toUpperCase())
    );

    logger.info(`Serving ${activeTrains.length} active trains`);
    res.json({ total: activeTrains.length, trains: activeTrains });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error in active endpoint: ${err.message}`);
    res.status(500).json({ error: 'Failed to fetch active trains' });
  }
});

/** GET /api/station/:stationId - Fetch all trains at station */
app.get('/api/station/:stationId', async (req: Request, res: Response) => {
  const { stationId } = req.params;
  if (!stationId) {
    res.status(400).json({ error: 'Invalid stationId' });
    return
  }

  try {
    const stationData = await getStationData(stationId);
    if (!stationData) { res.status(404).json({ error: 'Not Found' }); return; }
    // Use cached data (even if stale) to provide fast response
    logger.info(`num of stationData.obj ${Object.values(stationData).length}`)
    const stationTrains = Object.values(stationData).map(train => {
      const trainId = Number(train.trainNumber);
      return getCachedTrainData(trainId);
    }).filter(Boolean) as Train[];
    logger.info(`num of stationTrains ${stationTrains.length}`)

    // Create response objects without trainStops
    const responseTrains = stationTrains.filter(train =>
      train.status
    );
    logger.info(`Serving ${responseTrains.length} trains at station ${stationId}`);
    res.json({ total: responseTrains.length, trains: responseTrains });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error in station endpoint: ${err.message}`);
    res.status(500).json({ error: 'Failed to fetch trains at station' });
  }
});

interface TrainMetrics {
  totalTrains: number;
  statusBreakdown: Record<string, number>;
  serviceBreakdown: Record<string, number>;
  cachedTrains: number;
  cacheHitRate: string;
  activeTrains: number;
  averageDelay: string;
  queueSize: number;
  refreshInProgress: boolean;
}

/** GET /api/trains/metrics - Fetch train metrics */
app.get('/api/trains/metrics', async (req: Request, res: Response) => {
  const now = Date.now();
  try {
    // Use cached data for metrics endpoint
    const allTrains = trainsData.map(train => {
      const trainId = Number(train.trainNumber);
      return getCachedTrainData(trainId) || train;
    });

    const validTrains = allTrains.filter(Boolean) as Train[];
    const metrics = calculateMetrics(validTrains, now);
    logger.info(`Serving metrics: ${JSON.stringify(metrics)}`);
    res.json(metrics);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error in metrics endpoint: ${err.message}`);
    res.status(500).json({ error: 'Failed to fetch train metrics' });
  }
});

// Helper function to calculate metrics
function calculateMetrics(trains: Train[], now: number): TrainMetrics {
  const statusCounts: Record<string, number> = {};
  const serviceCounts: Record<string, number> = {};
  let cachedCount = 0;
  let totalDelay = 0;
  let delayedTrains = 0;

  trains.forEach(train => {
    const status = (train.status || 'UNKNOWN').toUpperCase();
    const service = (train.serviceCode?.code || 'UNKNOWN').toUpperCase();
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    serviceCounts[service] = (serviceCounts[service] || 0) + 1;

    const trainId = Number(train.trainNumber);
    const cached = trainCache.get(trainId);
    if (cached && cached.timestamp + cached.ttl > now) cachedCount++;

    if (train.delay && train.delay > 0) {
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

interface CacheStatus {
  totalCached: number;
  validCache: number;
  expiredCache: number;
  queueSize: number;
  refreshInProgress: boolean;
}

/** GET /api/cache/status - View cache status */
app.get('/api/cache/status', (req: Request, res: Response) => {
  const now = Date.now();
  const status: CacheStatus = {
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

interface RefreshRequest {
  trainId?: string | number;
}

/** POST /api/cache/refresh - Manually trigger cache refresh */
app.post('/api/cache/refresh', (req: Request, res: Response) => {
  const { trainId } = req.body as RefreshRequest;

  if (trainId) {
    const numericTrainId = Number(trainId);
    if (isNaN(numericTrainId)) {
      res.status(400).json({ error: 'Invalid trainId' });
      return
    }
    queueTrainForRefresh(numericTrainId, true);
    res.json({ message: `Train ${numericTrainId} queued for refresh` });
  } else {
    // Queue all trains for refresh
    trainsData.forEach(train => {
      const trainId = Number(train.trainNumber);
      queueTrainForRefresh(trainId);
    });
    res.json({ message: `All trains queued for refresh` });
  }
});

// Handle the specific route: /api/route/v1/train
app.get('/api/osrm/route/v1/train/:coordinates', async (req: Request, res: Response) => {
  try {
    // Extract coordinates from query parameters
    const coordinates = req.params.coordinates;
    if (!coordinates) {
      res.status(400).send('Coordinates are required');
      return;
    }
    if (typeof coordinates !== 'string') {
      res.status(400).send('Coordinates must be a string');
      return;
    }
    const hash = stringToHash(coordinates);
    logger.info(coordinates)
    const cached = coordsCache.get(hash);
    const now = Date.now();
    if (cached && now - cached.timestamp < cached.ttl) {
      logger.info(`Cache hit for coordinates ${coordinates}`);
      res.json(JSON.parse(cached.data));
      return;
    } else {
      const proxiedUrl = `http://osrm-server:5000/route/v1/train/${coordinates}?geometries=geojson&overview=full`;
      logger.info(proxiedUrl)
      const response = await fetch(proxiedUrl);
      const data = await response.json();
      coordsCache.set(hash, { data: JSON.stringify(data), timestamp: now, ttl: 30000 });
      res.json(data);
      return;
    }
  } catch (error) {
    const err = error as Error;
    logger.error(`Error in proxy request: ${err}`);
    res.status(500).send('Internal Server Error');
    return;
  }
});


// Centralized error handling
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error(`Unhandled error on ${req.method} ${req.path}: ${err.message}`, { stack: err.stack });
  res.status(500).json({ error: 'Internal Server Error' });
});

// Start server
const PORT = process.env.PORT ? parseInt(process.env.PORT) : DEFAULT_PORT;
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