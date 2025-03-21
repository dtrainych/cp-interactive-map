# Interactive CP Map

Interactive CP Map is a project designed to provide a visual and interactive representation of CP (Comboios de portugal) data. It integrates backend services, frontend interfaces, and geospatial data to deliver a seamless user experience.

## Project Structure

The project is organized into the following directories:

- **cp-backend/**: Contains the backend services written in TypeScript. It includes API endpoints, data processing logic, and server configurations.
- **cp-frontend/**: Contains the frontend application built with modern web technologies. It provides the user interface for interacting with the map and data.
- **osrm-train-profile/**: Includes configurations and profiles for OSRM (Open Source Routing Machine) tailored for train routing.


## Features

- **Interactive Map**: Visualize CP data on an interactive map.
- **Backend API**: Provides endpoints for querying and managing CP data.
- **Frontend Interface**: User-friendly interface for exploring and interacting with the map.
- **OSRM Integration**: Train routing capabilities using OSRM.

## Prerequisites

- Docker
- Node.js (for frontend and backend development)
- Python (for data parsing scripts)

## Setup

1. Clone the repository:
   ```sh
   git clone https://github.com/your-repo/interactive-cp-map.git
   cd interactive-cp-map
   ```
2. Build and run the Docker containers:
    ```
    docker-compose up --build
    ```
3. Access the application:  
    Frontend: http://localhost:1651  
    Backend API: http://localhost:1651