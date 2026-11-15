import test from 'node:test';
import assert from 'node:assert/strict';
import { evidenceAtCutoff } from '../web/decisions-view.js';

const inputs = (issued = '2024-06-16T23:00:00Z') => ({
  weather: { forecast: { status: 'available', issued_at: issued, generated_at: '2024-06-16T23:05:00Z', periods: [{ start: '2024-06-17T00:00:00Z', end: '2024-06-17T01:00:00Z' }] } },
  hyperspectral: { scenes: [{ acquired_at: '2024-04-23T18:33:57Z' }, { acquired_at: '2024-06-18T12:00:00Z' }] },
});

test('A forecast issued after the research cutoff is unavailable even when its valid interval contains that cutoff', () => {
  assert.equal(evidenceAtCutoff(inputs('2024-06-17T00:01:00Z'), '2024-06-17T00:00:00Z', 7).forecastAvailable, false);
});

test('A forecast snapshot generated after the cutoff, or without generation time, is withheld', () => {
  for (const generated_at of ['2024-06-17T00:05:00Z', null]) {
    const data = inputs();
    data.weather.forecast.generated_at = generated_at;
    assert.equal(evidenceAtCutoff(data, '2024-06-17T00:00:00Z', 7).forecastAvailable, false);
  }
});

test('A prior forecast is available only within its valid interval, and hotspot context requires archive coverage', () => {
  const valid = evidenceAtCutoff(inputs(), '2024-06-17T00:00:00Z', 7);
  assert.equal(valid.forecastAvailable, true);
  assert.equal(valid.archiveCovered, true);
  assert.equal(evidenceAtCutoff(inputs(), '2024-06-17T01:00:00Z', 7).forecastAvailable, false);
  assert.equal(evidenceAtCutoff(inputs(), '2026-11-15T00:00:00Z', 7).archiveCovered, false);
  assert.equal(evidenceAtCutoff(inputs(), '2001-01-03T00:00:00Z', 7).archiveCovered, false);
});

test('Catalog scenes before the cutoff are counted without becoming measured spectral indices', () => {
  const evidence = evidenceAtCutoff(inputs(), '2024-06-17T00:00:00Z', 7);
  assert.deepEqual(evidence.scenes, [{ acquired_at: '2024-04-23T18:33:57Z' }]);
  assert.equal(evidence.spectralAvailable, false);
});

test('Sensor starts distinguish unavailable, partial and available lookback windows', () => {
  const starts = { terra: '2001-01-01', aqua: '2002-07-01', snpp: '2012-01-20' };
  assert.deepEqual(evidenceAtCutoff(inputs(), '2001-07-01T00:00:00Z', 7, starts).sensorAvailability, { terra: 'available', aqua: 'unavailable', snpp: 'unavailable' });
  assert.equal(evidenceAtCutoff(inputs(), '2012-01-23T00:00:00Z', 7, starts).sensorAvailability.snpp, 'partial');
  assert.equal(evidenceAtCutoff(inputs(), '2012-01-27T00:00:00Z', 7, starts).sensorAvailability.snpp, 'available');
  assert.equal(evidenceAtCutoff(inputs(), '2002-07-28T00:00:00Z', 7, starts).sensorAvailability.aqua, 'partial');
  assert.equal(evidenceAtCutoff(inputs(), '2002-08-08T00:00:00Z', 7, starts).sensorAvailability.aqua, 'available');
});

test('Measured spectral evidence requires the matching scene, study area and product creation before the cutoff', () => {
  const data = inputs();
  data.hyperspectral.scenes[0].title = 'test-scene';
  const index = { schema_version:1, status:'measured', scene_id:'test-scene', acquired_at:'2024-04-23T18:33:57Z',
    bbox:[-118.8,34.2,-118.2,34.7], quality:{valid_pixels:10,in_bbox:100}, statistics:{median:0.25},
    input_files:[{created_at:'2024-04-25T23:00:00Z'},{created_at:'2024-04-25T23:01:00Z'}] };
  assert.equal(evidenceAtCutoff(data,'2024-06-17T00:00:00Z',7,{},index).spectralAvailable,true);
  assert.equal(evidenceAtCutoff(data,'2024-04-24T00:00:00Z',7,{},index).spectralAvailable,false);
  assert.equal(evidenceAtCutoff(data,'2024-06-17T00:00:00Z',7,{}, {...index,scene_id:'other'}).spectralAvailable,false);
  assert.equal(evidenceAtCutoff(data,'2024-06-17T00:00:00Z',7,{}, {...index,bbox:[0,0,1,1]}).spectralAvailable,false);
  assert.equal(evidenceAtCutoff(data,'2024-06-17T00:00:00Z',7,{}, {...index,status:'no_valid_pixels',statistics:null}).spectralAvailable,false);
});
