import test from 'node:test';
import assert from 'node:assert/strict';
import { csvText, withPngDpi, svgPhysicalSize } from '../web/exports.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=', 'base64');
const density600 = Buffer.from('000000097048597300005c4600005c460114944341', 'hex');

function chunks(input) {
  const bytes = Buffer.from(input);
  const result = [];
  for (let offset = 8; offset < bytes.length;) {
    const end = offset + bytes.readUInt32BE(offset) + 12;
    result.push({ type: bytes.toString('ascii', offset + 4, offset + 8), bytes: bytes.subarray(offset, end) });
    offset = end;
  }
  return result;
}

test('Given commas, quotes, line breaks, Unicode, null and zero fields, CSV preserves values and quotes special fields', () => {
  assert.equal(csvText(['name', 'value'], [['Los Angeles, CA', 'a"b'], ['line\r\nbreak', null], ['α', 0], ['plain', undefined]]), 'name,value\r\n"Los Angeles, CA","a""b"\r\n"line\r\nbreak",\r\nα,0\r\nplain,\r\n');
});

test('Given PNG image chunks, setting 600 dpi adds a valid pHYs chunk and preserves image payloads', () => {
  const output = withPngDpi(png, 600);
  const after = chunks(output);
  assert.deepEqual(after.map((chunk) => chunk.type), ['IHDR', 'pHYs', 'IDAT', 'IEND']);
  assert.deepEqual(after[1].bytes, density600);
  assert.deepEqual(after.filter((chunk) => chunk.type !== 'pHYs').map((chunk) => chunk.bytes), chunks(png).map((chunk) => chunk.bytes));
  assert.equal(after[1].bytes.readUInt32BE(8), 23622);
  assert.equal(after[1].bytes[16], 1);
});

test('Given an existing PNG pHYs chunk, setting 600 dpi replaces its density without duplicate chunks', () => {
  const lower = withPngDpi(png, 96);
  const result = chunks(withPngDpi(lower, 600));
  assert.equal(result.filter((chunk) => chunk.type === 'pHYs').length, 1);
  assert.deepEqual(result.find((chunk) => chunk.type === 'pHYs').bytes, density600);
});

test('Given vector SVG paths and text, physical sizing retains vectors and adds exact inches and viewBox', () => {
  const path = '<path d="M0,0L100,100"/><text x="10" y="20">α</text>';
  const svg = svgPhysicalSize(`<svg xmlns="http://www.w3.org/2000/svg" width="687.36" height="343.68" viewBox="0 0 687.36 343.68">${path}</svg>`, 7.16, 3.58);
  assert.match(svg, /width="7\.16in"/);
  assert.match(svg, /height="3\.58in"/);
  assert.match(svg, /viewBox="0 0 687\.36 343\.68"/);
  assert.ok(svg.includes(path));
  assert.equal((svg.match(/viewBox=/g) ?? []).length, 1);
});

test('Given embedded raster SVG content, figure export rejects it instead of claiming a vector export', () => {
  assert.throws(() => svgPhysicalSize('<svg><image href="data:image/png;base64,AA"/></svg>', 7.16, 3.58), /unapproved raster/);
  assert.throws(() => svgPhysicalSize('<svg><foreignObject/></svg>', 7.16, 3.58), /unapproved raster/);
  assert.throws(() => svgPhysicalSize('<svg/>', 0, 1), /positive inches/);
});

test('Given corrupt or truncated PNG data, density export rejects the file', () => {
  assert.throws(() => withPngDpi(png.subarray(0, 30)), /Invalid PNG signature/);
  const corrupt = Buffer.from(png); corrupt[45] ^= 1;
  assert.throws(() => withPngDpi(corrupt), /checksum/);
});
