.PRECIOUS: %.pbf

# List all the source countries we need
WANTED_COUNTRIES := $(shell grep -v "\#" countries.wanted)

# Transform "belgium" to "world/belgium-latest.osm.pbf"
COUNTRIES_PBF := $(addsuffix -latest.osm.pbf,$(addprefix world/,$(WANTED_COUNTRIES)))

# Download the raw source file of a country
world/%.osm.pbf:
	wget -N -nv -P world/ https://download.geofabrik.de/europe/$*.osm.pbf

# Filter a raw country (in world/*) to rail-only data (in filtered/*)
filtered/%.osm.pbf: world/%.osm.pbf filter.params
	osmium tags-filter --expressions=filter.params $< -o $@ --overwrite

# Combine all rail-only data (in filtered/*) into one file
output/filtered.osm.pbf: $(subst world,filtered,$(COUNTRIES_PBF))
	osmium merge $^ -o $@ --overwrite

# Compute the real OSRM data on the combined file
output/filtered.osrm: output/filtered.osm.pbf basic.lua
	docker run -t -v $(shell pwd):/opt/host osrm/osrm-backend@sha256:af5d4a83fb90086a43b1ae2ca22872e6768766ad5fcbb07a29ff90ec644ee409 osrm-extract -p /opt/host/basic.lua /opt/host/$<

	docker run -t -v $(shell pwd):/opt/host osrm/osrm-backend@sha256:af5d4a83fb90086a43b1ae2ca22872e6768766ad5fcbb07a29ff90ec644ee409 osrm-partition /opt/host/$<
	docker run -t -v $(shell pwd):/opt/host osrm/osrm-backend@sha256:af5d4a83fb90086a43b1ae2ca22872e6768766ad5fcbb07a29ff90ec644ee409 osrm-customize /opt/host/$<

all: output/filtered.osrm

serve: output/filtered.osrm basic.lua
	docker run -t -i -p 5001:5000 -v $(shell pwd):/opt/host osrm/osrm-backend@sha256:af5d4a83fb90086a43b1ae2ca22872e6768766ad5fcbb07a29ff90ec644ee409 osrm-routed --algorithm mld /opt/host/$<
