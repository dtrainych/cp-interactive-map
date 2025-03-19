FROM osrm/osrm-backend@sha256:af5d4a83fb90086a43b1ae2ca22872e6768766ad5fcbb07a29ff90ec644ee409

ADD output .
CMD osrm-routed --algorithm mld filtered.osrm
