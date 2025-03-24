# Interactive CP Map


Interactive CP Map is a comprehensive visualization platform for Portugal's railway system, combining real-time train data with advanced routing capabilities. The system integrates modern web technologies with geospatial processing to deliver an immersive experience for tracking and analyzing train movements.


## Features

- 🚂 **Real-time Tracking**: Monitor active trains with live position updates
- 🗺️ **Interactive Map Interface**: Built with Leaflet.js for smooth zoom/pan operations
- 📡 **Backend API**: TypeScript-powered service with intelligent caching
- 🚄 **Train Routing**: Integrated OSRM engine with custom train routing profiles
- 📊 **Metrics Dashboard**: View system statistics and train performance data
- 🔐 **Security Features**: Rate limiting, CORS protection, and request validation
- 📦 **Containerized Deployment**: Full Docker support for easy setup

## Tech Stack

**Frontend**  
Vue 3 · Leaflet · Tailwind CSS  

**Backend**  
Node.js · Express · Winston · Redis-like caching  

**Routing**  
OSRM · Custom Lua profiles · Geospatial processing  

**Infrastructure**  
Docker · Nginx · Multi-stage builds  

## Getting Started

### Prerequisites

- Docker 20.10+
- Node.js 18+

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/your-repo/interactive-cp-map.git
   cd interactive-cp-map
   ```

2. Configure environment variables:
   ```bash
   cp example.env .env
   # Edit .env with your configuration
   ```

3. Build and start services:
   ```bash
   docker-compose up --build
   ```

4. Access the application:
   - Frontend: http://localhost:1651
   - Backend API: http://localhost:1651/api
   - OSRM Engine: http://localhost:1651/osrm

## Project Structure

```bash
├── cp-backend/          # TypeScript backend service
│   ├── src/             # Server logic and API endpoints
│   └── Dockerfile       # Multi-stage build configuration
├── cp-frontend/         # Vue.js frontend application
│   ├── public/          # Static assets
│   └── src/             # Map components and state management
├── osrm-train-profile/  # Custom routing configurations
├── docker-compose.yaml  # Service orchestration
└── nginx.conf               # Reverse proxy configuration
```

## API Documentation

### Core Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/train/{id}` | GET | Get detailed train information |
| `/api/trains/active` | GET | List all active trains |
| `/api/station/{id}` | GET | Get station schedule and arrivals |
| `/api/osrm/route/v1/train/{coords}` | GET | Calculate train route geometry |

### Example Request
```javascript
fetch('/api/train/21045')
  .then(response => response.json())
  .then(data => {
    console.log('Train Position:', data.latitude, data.longitude);
    console.log('Next Stop:', data.trainStops[0].station.designation);
  });
```

## Configuration

Key environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_URL` | `localhost:1651` | Frontend API base URL |
| `CORS_ORIGIN` | `*` | Allowed origins for CORS |
| `EXPOSE_PORT` | 1651 | Public facing port |

## Development

### Backend Setup
```bash
cd cp-backend
npm install
npm run dev
```

### Frontend Setup
```bash
cd cp-frontend
npm install
npm run dev
```


## License

Distributed under the GNU GPLv3 License. See `LICENSE` for more information.


## Acknowledgements

- Comboios de Portugal
- OpenStreetMap contributors
- OSRM Development Team
- Leaflet.js Community
