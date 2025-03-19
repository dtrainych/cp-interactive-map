// leaflet.d.ts
import 'leaflet';

declare module 'leaflet' {
  interface MarkerOptions {
    trainNumber?: number;
  }

  namespace control {
    function panToTrain(options?: ControlOptions): Control;
  }

  class Control {
    static PanToTrain: typeof Control;
  }
}