import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createRegionLoader } from '../web/regions.js';

const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const build = await readFile(new URL('../scripts/build.mjs', import.meta.url), 'utf8');

function interfaceHarness(hash = '') {
  class Element {
    constructor(id, tagName = 'DIV') {
      this.id = id; this.tagName = tagName; this.hidden = false; this.tabIndex = -1;
      this.attributes = {}; this.events = {}; this.dataset = {}; this.parentElement = null;
    }
    addEventListener(name, handler) { this.events[name] = handler; }
    setAttribute(name, value) { this.attributes[name] = value; }
    focus() { focused = this.id; }
    scrollIntoView() { this.scrolled = true; }
    closest(selector) {
      for (let element = this; element; element = element.parentElement) if (`#${element.id}` === selector) return element;
      return null;
    }
    dispatch(name, extra = {}) {
      const event = { preventDefault() { this.defaultPrevented = true; }, ...extra };
      this.events[name]?.(event);
      return event;
    }
  }
  let focused = null;
  const elements = new Map([...html.matchAll(/<([a-z0-9-]+)\b[^>]*\bid="([^"]+)"/g)].map(([, tag, id]) => [id, new Element(id, tag.toUpperCase())]));
  const get = (id) => elements.get(id);
  get('study-methods').parentElement = get('comparison-view');
  get('harmonization').parentElement = get('harmonization-details');
  get('harmonization-details').parentElement = get('calendar-view');
  const compareLink = new Element('compare-link', 'A');
  const calendarLink = new Element('calendar-link', 'A'); calendarLink.dataset.calendarTarget = 'harmonization';
  const windowEvents = {};
  const location = { hash };
  const document = {
    getElementById: get,
    querySelectorAll: (selector) => selector === '[data-open-comparison]' ? [compareLink]
      : selector === '[data-calendar-target]' ? [calendarLink]
      : selector === 'details' ? [...elements.values()].filter((element) => element.tagName === 'DETAILS') : [],
  };
  const window = { addEventListener(name, handler) { windowEvents[name] = handler; }, scrollTo() {} };
  const context = { document, window, location, history: { pushState(_state, _unused, next) { location.hash = next; } },
    requestAnimationFrame: (callback) => callback(), createRegionLoader, Intl, URL, Set, console };
  // Leave startup data loading to the integration checks; exercise production navigation handlers here.
  const navigationSource = app.replace(/^import .*;\r?\n/gm, '').replace(/\ninitialize\(\);\s*$/, '\n');
  vm.runInNewContext(navigationSource, context);
  return { get, compareLink, calendarLink, location, focused: () => focused, restore: () => windowEvents.hashchange() };
}

function assertActive(harness, name) {
  for (const view of ['calendar', 'comparison']) {
    assert.equal(harness.get(`${view}-view`).hidden, view !== name);
    assert.equal(harness.get(`${view}-tab`).attributes['aria-selected'], String(view === name));
    assert.equal(harness.get(`${view}-tab`).tabIndex, view === name ? 0 : -1);
  }
}

test('Published UI exposes the specified comparison controls and preserves the calendar without prediction or weather UI', () => {
  assert.match(html, /id="calendar-tab"[^>]*>Fire Calendar<\/button>/);
  assert.match(html, /id="comparison-tab"[^>]*aria-controls="comparison-view"[^>]*>Compare Locations<\/button>/);
  assert.match(html, /<h1>MODIS And VIIRS Harmonization<\/h1>/);
  assert.match(html, /<h1>Harmonization Across Four Counties<\/h1>/);
  assert.match(html, /id="comparison-status"[^>]*role="status"/);
  const method = html.match(/<select id="study-method"[^>]*>(.*?)<\/select>/s)[1];
  assert.deepEqual([...method.matchAll(/value="([^"]+)"/g)].map((match) => match[1]), ['raw', 'ratio', 'spatial_ratio']);
  assert.match(method, /value="ratio" selected>Count Ratio/);
  const view = html.match(/<select id="study-view"[^>]*>(.*?)<\/select>/s)[1];
  assert.match(view, /value="3d" selected>3D View/);
  assert.match(view, /value="2d">2D View/);
  for (const id of ['heatmap', 'county-map', 'region-select', 'example-terra', 'example-viirs', 'example-adjusted', 'cross-location-chart', 'study-chart-caption', 'study-summary', 'study-results']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /Count Ratio Calibration/);
  assert.match(html, /cannot reproduce MODIS pixels or align MODIS and VIIRS overpass times/);
  assert.match(html, /href="data\/harmonization-study.json" download/);
  assert.match(html, /<small>AI assisted code editor was used for development of this website<\/small>/);
  assert.doesNotMatch(html, /prediction|weather|hyperspectral|EMIT|allocation|data-open-decisions/i);
  assert.doesNotMatch(app, /initializePrediction|selectPredictionRegion|initializeDecisions|prediction\.js|decisions-view\.js/);
  assert.match(app, /import \{ initializeComparison \} from '\.\/comparison.js'/);
  assert.equal([...app.matchAll(/initializeComparison\(\)/g)].length, 1);
});

test('Tab clicks and the comparison link update panel visibility, URL and accessible selection', () => {
  const harness = interfaceHarness();
  assertActive(harness, 'calendar');
  harness.get('comparison-tab').dispatch('click');
  assert.equal(harness.location.hash, 'comparison');
  assertActive(harness, 'comparison');
  harness.get('calendar-tab').dispatch('click');
  assertActive(harness, 'calendar');
  assert.equal(harness.compareLink.dispatch('click').defaultPrevented, true);
  assert.equal(harness.location.hash, 'comparison');
  assertActive(harness, 'comparison');
});

test('Arrow, Home and End keys open and focus the corresponding tab while unrelated keys retain state', () => {
  const harness = interfaceHarness();
  for (const [from, key, target] of [['calendar', 'ArrowRight', 'comparison'], ['comparison', 'ArrowLeft', 'calendar'], ['calendar', 'ArrowLeft', 'comparison'], ['comparison', 'ArrowRight', 'calendar'], ['calendar', 'End', 'comparison'], ['comparison', 'Home', 'calendar']]) {
    assert.equal(harness.get(`${from}-tab`).dispatch('keydown', { key }).defaultPrevented, true);
    assert.equal(harness.location.hash, target);
    assertActive(harness, target);
    assert.equal(harness.focused(), `${target}-tab`);
  }
  assert.equal(harness.get('calendar-tab').dispatch('keydown', { key: 'Escape' }).defaultPrevented, undefined);
  assertActive(harness, 'calendar');
});

test('Deep links open the matching panel and details, with unknown hashes falling back to the calendar', () => {
  const harness = interfaceHarness('#study-methods');
  assertActive(harness, 'comparison');
  assert.equal(harness.get('study-methods').open, true);
  assert.equal(harness.focused(), 'study-methods');
  harness.location.hash = '#unknown'; harness.restore();
  assertActive(harness, 'calendar');
  harness.location.hash = '#comparison'; harness.restore();
  assertActive(harness, 'comparison');
  harness.calendarLink.dispatch('click');
  assertActive(harness, 'calendar');
  assert.equal(harness.get('harmonization-details').open, true);
  assert.equal(harness.location.hash, '#harmonization');
});

test('Runtime packaging includes comparison assets and excludes prediction, decision and spectral runtime inputs', () => {
  const files = build.match(/const runtimeFiles = (\[[^;]+\]);/)[1];
  const required = build.match(/const requiredData = (\[[^;]+\]);/)[1];
  assert.match(files, /'comparison.js'/);
  assert.doesNotMatch(files, /prediction|decision/);
  assert.match(required, /'harmonization-study.json'/);
  assert.doesNotMatch(required, /prediction|decision-inputs|emit-ndwi/);
  const excludes = build.match(/directory === 'data' && (\[[^\]]+\])\.includes\(basename\(name\)\)/)[1];
  for (const name of ['prediction.json', 'decision-inputs.json', 'emit-ndwi.json', 'historical-response.json', 'training-scenario.json', 'decision-scenario-template.json']) assert.ok(excludes.includes(`'${name}'`), name);
});
