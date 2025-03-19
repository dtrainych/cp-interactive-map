<script setup lang="ts">
import 'leaflet/dist/leaflet.css'
import L, { Map, Marker, type LatLngTuple, Polyline } from 'leaflet'
import { ref, onMounted, onUnmounted, computed, toRaw, watch } from 'vue'

interface TrainStop {
  station: { code: string; designation: string }
  arrival: string | null
  departure: string
  platform: string
  latitude: string
  longitude: string
  delay: number
  eta: string | null
  etd: string
}

interface TrainData {
  latitude?: number
  longitude?: number
  trainNumber?: number
  serviceCode?: { code: string; designation: string }
  delay?: number
  status?: string
  trainStops?: TrainStop[]
  error?: string
  [key: string]: any
}

interface AllTrains {
  trains: TrainData[],
  total: number
}

const apiURL = import.meta.env.VITE_API_URL
const trainId = ref<number | null>(null)
const allTrains = ref<AllTrains>({ trains: [], total: 0 })
const trainData = ref<TrainData>({})
const lastTrainData = ref<TrainData>({})
const map = ref<L.Map | null>(null)
const trainMarkers = ref<L.Marker[]>([]) // Array to hold multiple train markers
const stopMarkers = ref<L.CircleMarker[]>([]);
const routePolyline = ref<Polyline | null>(null)
let pollingInterval: ReturnType<typeof setInterval> | null = null
const isPolling = ref<boolean>(false)
const isAutoPanEnabled = ref<boolean>(false); // Toggle for auto-pan
let panToTrainControl: L.Control | null = null; // Store reference to the control
const polylineCache = ref<Record<string, { coordinates: number[][]; latLngs: LatLngTuple }>>({})




// Function to toggle auto-pan
const toggleAutoPan = () => {
  if (isAutoPanEnabled.value && panToTrainControl !== null) {
    const container = panToTrainControl.getContainer();
    if (container) {
      container.style.backgroundColor = 'white';
      container.style.color = 'black';
    }
  } else {
    if (panToTrainControl !== null) {
      const container = panToTrainControl.getContainer();
      if (container) {
        container.style.backgroundColor = 'blue';
        container.style.color = 'white';
      }
    }
  }
  isAutoPanEnabled.value = !isAutoPanEnabled.value;

  if (isAutoPanEnabled.value && trainData.value.latitude && trainData.value.longitude) {
    map.value?.setView([trainData.value.latitude, trainData.value.longitude], 15, { animate: true });
  }
};


const currentTime = computed(() => {
  const now = new Date()
  return now.getHours() * 60 + now.getMinutes()
})

const nextStation = computed(() => {
  if (!trainData.value.trainStops || !trainData.value.latitude || !trainData.value.longitude) return null
  const trainLat = trainData.value.latitude
  const trainLon = trainData.value.longitude
  for (let i = 0; i < trainData.value.trainStops.length; i++) {
    const stop = trainData.value.trainStops[i]
    const eta = stop.eta ? parseTime(stop.eta) : parseTime(stop.arrival || stop.departure)
    if (eta > currentTime.value) {
      const stopLat = parseFloat(stop.latitude)
      const stopLon = parseFloat(stop.longitude)
      const distance = haversineDistance(trainLat, trainLon, stopLat, stopLon)
      if (distance > 0.1) return stop
    }
  }
  return trainData.value.trainStops[trainData.value.trainStops.length - 1]
})

const timeUntilArrival = computed(() => {
  if (!trainData.value.trainStops) return null
  const lastStop = trainData.value.trainStops[trainData.value.trainStops.length - 1]
  const arrivalInMinutes = parseTime(lastStop.eta || lastStop.arrival || lastStop.departure) - currentTime.value
  if (arrivalInMinutes < 0) return "Arrived"
  const hours = Math.floor(arrivalInMinutes / 60)
  const minutes = arrivalInMinutes % 60
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
})

const parseTime = (timeStr: string): number => {
  const [hours, minutes] = timeStr.split(':').map(Number)
  return hours * 60 + minutes
}

const haversineDistance = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

const getQueryParam = (param: string): string | null => {
  const urlParams = new URLSearchParams(window.location.search)
  return urlParams.get(param)
}

const setQueryParam = (param: string, value: string): void => {
  const urlParams = new URLSearchParams(window.location.search)
  urlParams.set(param, value)
  window.history.replaceState({}, '', `${window.location.pathname}?${urlParams}`)
}

const removeQueryParam = (param: string): void => {
  const urlParams = new URLSearchParams(window.location.search)
  urlParams.delete(param)
  window.history.replaceState({}, '', `${window.location.pathname}?${urlParams}`)
}

const fetchTrainData = async (): Promise<void> => {
  if (trainId.value === null) return
  try {
    const response = await fetch(`${apiURL}/api/train/${trainId.value}`)
    if (!response.ok) throw new Error(`Proxy returned ${response.status}: ${response.statusText}`)
    const data: TrainData = await response.json()
    trainData.value = data
    if (data.latitude !== undefined && data.longitude !== undefined) {
      updateMarkerPosition(data, [data.latitude, data.longitude])
    }
    updateStopMarkers()
    await drawPolyline()
    lastTrainData.value = trainData.value
  } catch (error) {
    console.error('Failed to fetch train data:', error)
    trainData.value = { error: error instanceof Error ? error.message : String(error) }
  }
}

const fetchAllTrains = async (): Promise<void> => {
  try {
    const response = await fetch(`${apiURL}/api/trains/in-transit`)
    if (!response.ok) throw new Error(`Proxy returned ${response.status}: ${response.statusText}`)
    const data: AllTrains = await response.json()
    allTrains.value = data
    if (data.total > 0) {
      data.trains.forEach(train => {
        if (train.latitude !== undefined && train.longitude !== undefined) {
          updateMarkerPosition(train, [train.latitude, train.longitude])
        }
      })
    }
  } catch (error) {
    console.error('Failed to fetch all trains:', error)
  }
}

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

const drawPolyline = async (): Promise<void> => {
  if (!map.value || !trainData.value.trainStops) return
  const rawMap = toRaw(map.value)

  const coordinates = trainData.value.trainStops.map(stop => `${stop.longitude},${stop.latitude}`).join(';')
  try {
    let latLngs: LatLngTuple = [0, 0]
    if (polylineCache.value[stringToHash(coordinates)]) {
      ({ latLngs } = polylineCache.value[stringToHash(coordinates)])
    } else {
      const osrmUrl = `${apiURL}/osrm/route/v1/train/${coordinates}?geometries=geojson&overview=full`

      const response = await fetch(osrmUrl)
      if (!response.ok) throw new Error(`OSRM request failed: ${response.statusText}`)
      const data = await response.json()
      if (data.code !== 'Ok') throw new Error('OSRM returned an error')
      const geoJsonCoordinates = data.routes[0].geometry.coordinates
      latLngs = geoJsonCoordinates.map((coord: any[]) => [coord[1], coord[0]])
      polylineCache.value[stringToHash(coordinates)] = { coordinates: geoJsonCoordinates, latLngs }
    }
    // Remove existing polyline
    if (routePolyline.value) {
      rawMap.removeLayer(toRaw(routePolyline.value) as L.Polyline);
    }

    // Add new polyline (will be in default overlayPane with z-index 400)
    routePolyline.value = L.polyline(latLngs as unknown as L.LatLngExpression[], {
      color: 'blue',
      weight: 3,
      opacity: 0.8
    }).addTo(rawMap as L.Map);
    if (lastTrainData.value.trainNumber != trainId.value) rawMap.fitBounds(routePolyline.value.getBounds());

    // After drawing polyline, make sure to create/update stop markers
    updateStopMarkers()
  } catch (error) {
    console.error('Error drawing polyline:', error)
  }
}

const handleTrainMarkerClick = (trainNumber: number): void => {
  if (trainId.value === trainNumber) return
  // Set the selected train ID
  trainId.value = trainNumber
  // Start polling for this train
  startPolling()
}

const clearRouteAndStops = (): void => {
  // Remove polyline if it exists
  if (routePolyline.value && map.value) {
    const rawMap = toRaw(map.value)
    rawMap.removeLayer(toRaw(routePolyline.value as L.Polyline))
    routePolyline.value = null
  }

  // Remove all stop markers
  stopMarkers.value.forEach(marker => toRaw(marker).remove())
  stopMarkers.value = []

  // Stop polling when clicking outside
  stopPolling()
}

const updateMarkerPosition = (train: TrainData, latLng: LatLngTuple): void => {
  if (!train.latitude || !train.longitude || !map.value || !train.trainNumber) return

  const trainNumber = train.trainNumber
  const rawMap = toRaw(map.value)


  // Find existing marker for this train
  const existingMarker = trainMarkers.value.find(marker =>
  (marker.options as any).trainNumber === trainNumber
  )

  if (existingMarker) {
    // Update existing marker position
    toRaw(existingMarker).setLatLng(latLng)
  } else {
    // Create new marker
    const newMarker = L.marker(latLng, {
      icon: L.icon({
        iconUrl: 'https://cdn-icons-png.flaticon.com/512/3448/3448664.png',
        iconSize: [41, 41],
        iconAnchor: [20, 41],
        popupAnchor: [0, -41] // Adjust this value if needed
      }),
      trainNumber: trainNumber // Custom property to identify the train
    } as L.MarkerOptions).addTo(rawMap as L.Map)
      .bindPopup(`Train ${trainNumber}<br>Status: ${train.status || 'N/A'}`, { autoClose: false })

    // Add click handler to the marker
    newMarker.on('click', () => {
      handleTrainMarkerClick(trainNumber)
    })

    trainMarkers.value.push(newMarker)
  }
  if (isAutoPanEnabled.value) {
    rawMap.panTo(latLng, { animate: true });
  }
}

// Then add stop markers to the custom pane (higher z-index)
const updateStopMarkers = (): void => {
  if (!map.value || !trainData.value.trainStops) return
  const rawMap = toRaw(map.value)

  // Remove existing stop markers
  stopMarkers.value.forEach(marker => toRaw(marker).remove())
  stopMarkers.value = []

  // Create new stop markers as small circles in the custom pane
  stopMarkers.value = trainData.value.trainStops.map(stop => {
    const lat = parseFloat(stop.latitude)
    const lon = parseFloat(stop.longitude)

    // Create a circle marker in the stopsPane
    return L.circleMarker([lat, lon], {
      radius: 6,
      fillColor: '#3388ff',
      color: '#fff',
      weight: 1,
      opacity: 1,
      fillOpacity: 0.8,
      pane: 'stopsPane' // Use the custom pane with higher z-index
    }).addTo(rawMap as L.Map)
      .bindPopup(`<b>${stop.station.designation}</b><br>Arrival: ${stop.arrival || 'N/A'}<br>Departure: ${stop.departure}<br>Platform: ${stop.platform}<br>Delay: ${stop.delay < 0 ? "0" : stop.delay} min`, { autoClose: false })
  })

}

const startPolling = (): void => {
  if (trainId.value === null) return
  isPolling.value = true
  setQueryParam('trainId', String(trainId.value))
  if (pollingInterval) clearInterval(pollingInterval)
  fetchTrainData()
  pollingInterval = setInterval(fetchTrainData, 5000)
}

const stopPolling = (): void => {
  isPolling.value = false
  trainData.value = {}
  trainId.value = 0
  removeQueryParam('trainId')
  if (pollingInterval) {
    clearInterval(pollingInterval)
    pollingInterval = null
  }
}

const togglePolling = (): void => {
  if (isPolling.value) { stopPolling(); clearRouteAndStops() }
  else startPolling();
}
// Show or remove the button when polling starts/stops
const updatePanToTrainControl = () => {
  if (isPolling.value && !panToTrainControl && map.value) {
    createPanToTrainControl();
    // Add non-null assertion and remove optional chaining
    panToTrainControl!.addTo(map.value as L.Map);
  } else if (!isPolling.value && panToTrainControl) {
    panToTrainControl.remove();
    panToTrainControl = null;
  }
};
// Watch for changes in isPolling
watch(isPolling, updatePanToTrainControl);

// Create a custom Leaflet control
const createPanToTrainControl = () => {
  
  class PanToTrainControl extends L.Control {
    onAdd(map: L.Map): HTMLElement {
      const container = L.DomUtil.create('button', 'leaflet-bar leaflet-control leaflet-control-custom');
      container.innerHTML = '📍'; // Icon for the button
      container.style.width = '35px';
      container.style.height = '35px';
      container.style.cursor = 'pointer';
      container.style.fontSize = '18px';
      container.style.textAlign = 'center';
      container.style.lineHeight = '35px';
      container.style.backgroundColor = 'white';
      container.style.border = '2px solid rgba(0,0,0,0.2)';
      container.style.borderRadius = '4px';

      container.onclick = toggleAutoPan;
      return container;
    }
  };

// Explicitly type the control factory function
L.control.panToTrain = (opts?: L.ControlOptions): L.Control => {
    return new PanToTrainControl(opts) as L.Control;
  };

  // Explicitly type the control instance
  panToTrainControl = L.control.panToTrain({ position: 'topleft' }) as L.Control;
};

// Modify the initMap function to add the map click handler
const initMap = (): void => {
  map.value = L.map('map', { center: [39.3999, -8.2245], zoom: 8 })
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map.value as L.Map)

  // Create a custom pane for stop markers with higher z-index
  map.value.createPane('stopsPane')
  if (map.value.getPane('stopsPane')) {
    const stopsPane = map.value.getPane('stopsPane');
    if (stopsPane) {
      stopsPane.style.zIndex = "650"; // Default overlay pane is 400, shadow pane is 500, markers pane is 600
    }
  }

  // Add click handler to the map
  map.value.on('click', (e) => {
    // Check if the click is on a marker or popup (do nothing if it is)
    const target = (e.originalEvent.target as HTMLElement);
    const clickedOnMarkerOrPopup =
      target && (
        target.closest('.leaflet-marker-icon') ||
        target.closest('.leaflet-popup') ||
        target.closest('.leaflet-control')
      );

    if (!clickedOnMarkerOrPopup) {
      clearRouteAndStops();
    }
  })
  updatePanToTrainControl(); // Ensure the button appears if polling is active

}

onMounted(() => {
  initMap()
  const queryTrainId = getQueryParam('trainId')
  if (queryTrainId) {
    trainId.value = parseInt(queryTrainId, 10)
    startPolling()
  }
  fetchAllTrains()
})

onUnmounted(() => {
  stopPolling()
  if (map.value) toRaw(map.value).remove()
})
</script>

<template>
  <div class="flex flex-col sm:flex-row h-screen">
    <!-- Sidebar -->
    <div class="w-full sm:w-80 bg-gray-100 p-4 shadow-lg">
      <div class="mb-4">
        <input v-model.number="trainId" type="number" placeholder="Enter Train ID"
          class="w-full p-2 border rounded focus:ring-2 focus:ring-blue-400" />
      </div>
      <button @click="togglePolling()"
        :class="['w-full py-2 rounded text-white font-semibold', isPolling ? 'bg-red-500' : 'bg-green-500']">
        {{ isPolling ? "Stop" : "Start" }} Tracking
      </button>

      <pre v-if="trainData.error" class="text-red-600 mt-2">{{ trainData.error }}</pre>

      <div v-else class="mt-4 bg-white p-4 rounded shadow ">
        <strong v-if="trainData.trainStops">
          {{ trainData.trainStops[0].station.designation }} - {{ trainData.trainStops[trainData.trainStops.length -
            1].station.designation }}
        </strong>
      </div>
    </div>

    <!-- Map Section -->
    <div id="map" class="flex-1 bg-gray-200 h-[50vh] sm:h-screen min-h-[300px]"></div>
  </div>
</template>

<style scoped>
@media (max-width: 768px) {
  .flex {
    flex-direction: column;
  }

  .w-80 {
    width: 100%;
  }

  #map {
    height: 50vh;
  }
}
</style>