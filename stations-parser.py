import requests
from bs4 import BeautifulSoup
import json
import time
import re

# Your station-index JSON (abbreviated here)
stations = {}

# Headers to mimic a browser (helps avoid blocks)
headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
}

# Store results
station_coords = {}
url = "https://www.cp.pt/sites/spring/station-index"
try:
    response = requests.get(url, headers=headers)
    response.raise_for_status()  # Check for HTTP errors
    stations = response.json()
except Exception as e:
        print(f"Error: {e}")



for name, station_id in stations.items():
    #remove spaces and replace them with minus
    name = name.replace(" ", "-")
    #using regex change 2 or three minuses to one
    name = re.sub(r"-{2,}", "-", name)
    url = f"https://www.cp.pt/passageiros/pt/consultar-horarios/estacoes/{name}"
    try:
        response = requests.get(url, headers=headers)
        response.raise_for_status()  # Check for HTTP errors
        soup = BeautifulSoup(response.text, "html.parser")

        # Find the coordinates <li> tag
        coord_tag = soup.find("strong", string="Coordenadas: ")
        if coord_tag:
            coord_text = coord_tag.next_sibling  # Gets "40.6904372758|-8.4795604995"
            lat, lon = map(float, coord_text.split("|"))
            station_coords[station_id] = {"name": name, "lat": lat, "lon": lon}
            print(f"Got {name}: lat={lat}, lon={lon}")
        else:
            print(f"No coordinates found for {name}")
    except Exception as e:
        print(f"Error fetching {name}: {e}")

    # Be polite to CP's servers
    time.sleep(1)  # 1-second delay between requests

# Save to JSON file
with open("station_coords.json", "w") as f:
    json.dump(station_coords, f, indent=2)

print("Done! Coordinates saved to station_coords.json")