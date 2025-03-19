import requests
import time
from typing import Dict, List, Set

# Base URLs for the API endpoints
STATION_INDEX_URL = "https://www.cp.pt/sites/spring/station-index"
STATION_TRAINS_URL = "https://www.cp.pt/sites/spring/station/trains?stationId={station_id}"
TRAIN_DETAILS_URL = "https://www.cp.pt/sites/spring/station/trains/train?trainId={train_id}"

def get_all_stations() -> Dict[str, str]:
    """Fetch the list of all stations and their IDs."""
    response = requests.get(STATION_INDEX_URL)
    response.raise_for_status()  # Raise an error if the request fails
    return response.json()

def get_trains_at_station(station_id: str) -> List[Dict]:
    """Fetch the list of trains stopping at a given station."""
    url = STATION_TRAINS_URL.format(station_id=station_id)
    response = requests.get(url)
    response.raise_for_status()
    return response.json()

def get_train_details(train_id: int) -> Dict:
    """Fetch detailed information for a specific train."""
    url = TRAIN_DETAILS_URL.format(train_id=train_id)
    response = requests.get(url)
    response.raise_for_status()
    return response.json()

def fetch_all_trains() -> List[Dict]:
    """Fetch and store a list of all unique trains."""
    # Step 1: Get all stations
    stations = get_all_stations()
    print(f"Found {len(stations)} stations.")

    # Step 2: Collect unique train numbers from all stations
    unique_train_numbers: Set[int] = set()
    for station_name, station_id in stations.items():
        try:
            trains = get_trains_at_station(station_id)
            for train in trains:
                unique_train_numbers.add(train["trainNumber"])
            print(f"Processed station: {station_name}, found {len(trains)} trains.")
        except requests.RequestException as e:
            print(f"Error fetching trains for {station_name}: {e}")
        time.sleep(1/10)  # Rate limiting to avoid overwhelming the server

    print(f"Total unique trains found: {len(unique_train_numbers)}")

    # Step 3: Fetch detailed train data for each unique train
    all_trains = []
    for train_number in unique_train_numbers:
        try:
            train_details = get_train_details(train_number)
            all_trains.append(train_details)
            print(f"Fetched details for train {train_number}")
        except requests.RequestException as e:
            print(f"Error fetching details for train {train_number}: {e}")
        time.sleep(1/10)  # Rate limiting

    return all_trains

def main():
    """Main function to execute the train data collection."""
    trains = fetch_all_trains()
    print(f"Collected {len(trains)} trains.")
    
    # Optionally, save to a file
    import json
    with open("trains.json", "w", encoding="utf-8") as f:
        json.dump(trains, f, ensure_ascii=False, indent=2)
    print("Train data saved to trains.json")

if __name__ == "__main__":
    main()