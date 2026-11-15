import { circleArea, rectangleArea, validateAreaCoverage, areaDescription } from './area.js';

export function createAreaControls({ map, county, onApply }) {
  const get = (id) => document.getElementById(id);
  const draw = get('draw-area'), clear = get('clear-area'), form = get('coordinate-form');
  const status = get('area-status');
  const overlay = L.layerGroup().addTo(map);
  let area = null, first = null, drawing = false, disposed = false;
  let restoreDragging = false, restoreDoubleClick = false;
  const style = { color: '#63568b', weight: 2, dashArray: '6 4', fillOpacity: .04, interactive: false };

  function message(value, error = false) {
    status.textContent = value;
    status.classList.toggle('error-message', error);
  }

  function showArea() {
    overlay.clearLayers();
    if (!area) return;
    const shape = area.type === 'circle'
      ? L.circle([area.latitude, area.longitude], { ...style, radius: area.radiusKm * 1000 })
      : L.rectangle([[area.south, area.west], [area.north, area.east]], style);
    overlay.addLayer(shape);
  }

  function stopDrawing() {
    if (!drawing) return;
    drawing = false; first = null;
    if (restoreDragging) map.dragging.enable();
    if (restoreDoubleClick) map.doubleClickZoom.enable();
    map.getContainer().classList.remove('drawing-area');
    draw.textContent = 'Draw Area'; draw.setAttribute('aria-pressed', 'false');
    showArea();
  }

  async function apply(next) {
    try {
      if (next) validateAreaCoverage(next, county);
      stopDrawing();
      area = next; showArea(); clear.disabled = !area;
      message(area ? `${areaDescription(area)}. Only observations inside this county are included.` : 'County-wide record. Draw two corners or enter coordinates to select an area.');
      if (area?.type === 'circle') map.fitBounds(overlay.getLayers()[0].getBounds(), { padding: [24, 24], maxZoom: 13, animate: false });
      await onApply(area);
    } catch (error) {
      if (!disposed) { stopDrawing(); message(error.message, true); }
    }
  }

  function toggleDrawing() {
    if (drawing) {
      stopDrawing(); message('Drawing canceled. The current selection is unchanged.'); return;
    }
    drawing = true; first = null;
    restoreDragging = map.dragging.enabled(); restoreDoubleClick = map.doubleClickZoom.enabled();
    map.dragging.disable(); map.doubleClickZoom.disable(); map.closePopup();
    map.getContainer().classList.add('drawing-area');
    draw.textContent = 'Cancel Drawing'; draw.setAttribute('aria-pressed', 'true');
    message('Click or tap the first corner, then the opposite corner. Escape cancels. Coordinates are available below for keyboard entry.');
  }

  function mapClick(event) {
    if (!drawing) return;
    map.closePopup();
    if (!first) { first = event.latlng; message('Choose the opposite corner. Escape cancels.'); return; }
    try { apply(rectangleArea(first, event.latlng)); }
    catch (error) { stopDrawing(); message(error.message, true); }
  }

  function mapMove(event) {
    if (!drawing || !first) return;
    overlay.clearLayers(); overlay.addLayer(L.rectangle([first, event.latlng], style));
  }

  function keyDown(event) {
    if (event.key === 'Escape' && drawing) { stopDrawing(); message('Drawing canceled. The current selection is unchanged.'); draw.focus(); }
  }

  draw.onclick = toggleDrawing;
  clear.onclick = () => apply(null);
  form.onsubmit = (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    try { apply(circleArea(get('area-latitude').valueAsNumber, get('area-longitude').valueAsNumber, get('area-radius').valueAsNumber)); }
    catch (error) { message(error.message, true); }
  };
  const center = L.geoJSON(county).getBounds().getCenter();
  get('area-latitude').value = center.lat.toFixed(4);
  get('area-longitude').value = center.lng.toFixed(4);
  get('area-radius').value = 10;
  clear.disabled = true;
  message('County-wide record. Draw two corners or enter coordinates to select an area.');
  map.on('click', mapClick); map.on('mousemove', mapMove);
  document.addEventListener('keydown', keyDown);
  return {
    clear() { stopDrawing(); area = null; showArea(); clear.disabled = true; message('County-wide record. Draw two corners or enter coordinates to select an area.'); },
    dispose() {
      disposed = true; stopDrawing(); map.off('click', mapClick); map.off('mousemove', mapMove);
      document.removeEventListener('keydown', keyDown); overlay.remove();
      draw.onclick = null; clear.onclick = null; form.onsubmit = null;
    },
  };
}
