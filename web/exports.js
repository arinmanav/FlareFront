export function csvText(headers, rows) {
  const field = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [headers, ...rows].map((row) => row.map(field).join(',')).join('\r\n') + '\r\n';
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadCsv(filename, headers, rows) {
  downloadBlob(filename, new Blob([csvText(headers, rows)], { type: 'text/csv;charset=utf-8' }));
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function withPngDpi(input, dpi = 600) {
  if (!Number.isFinite(dpi) || dpi <= 0) throw new Error('PNG density must be positive.');
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || !signature.every((byte, index) => bytes[index] === byte)) throw new Error('Invalid PNG signature.');
  const chunks = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let ended = false;
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) throw new Error('Truncated PNG chunk.');
    const length = view.getUint32(offset);
    const end = offset + length + 12;
    if (end > bytes.length) throw new Error('Truncated PNG payload.');
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4)) throw new Error(`Invalid PNG ${type} checksum.`);
    if (!chunks.length && type !== 'IHDR') throw new Error('PNG must start with IHDR.');
    if (type !== 'pHYs') chunks.push(bytes.slice(offset, end));
    if (type === 'IEND') { ended = true; if (end !== bytes.length) throw new Error('Unexpected data after PNG IEND.'); }
    offset = end;
  }
  if (!ended) throw new Error('PNG is missing IEND.');
  const density = Math.round(dpi / .0254);
  const physical = new Uint8Array(21);
  const physicalView = new DataView(physical.buffer);
  physicalView.setUint32(0, 9);
  physical.set([112, 72, 89, 115], 4);
  physicalView.setUint32(8, density);
  physicalView.setUint32(12, density);
  physical[16] = 1;
  physicalView.setUint32(17, crc32(physical.subarray(4, 17)));
  chunks.splice(1, 0, physical);
  const output = new Uint8Array(8 + chunks.reduce((size, chunk) => size + chunk.length, 0));
  output.set(signature);
  let offset = 8;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}

function checkDimensions(widthInches, heightInches) {
  if (![widthInches, heightInches].every((value) => Number.isFinite(value) && value > 0 && value <= 30)) throw new Error('Figure dimensions must be positive inches, at most 30.');
}

export function svgPhysicalSize(svg, widthInches, heightInches) {
  checkDimensions(widthInches, heightInches);
  if (/<(?:[\w-]+:)?(?:image|foreignObject)\b/i.test(svg)) throw new Error('SVG contains an unapproved raster or foreign-object layer.');
  const root = svg.match(/<svg\b[^>]*>/i);
  if (!root) throw new Error('A valid SVG root is required.');
  const stripped = root[0].replace(/\s(?:width|height|viewBox)\s*=\s*(?:"[^"]*"|'[^']*')/gi, '');
  const dimensions = ` width="${widthInches}in" height="${heightInches}in" viewBox="0 0 ${widthInches * 96} ${heightInches * 96}"`;
  return svg.replace(root[0], stripped.replace(/>$/, `${dimensions}>`));
}

function decodeSvgUrl(url) {
  const comma = url.indexOf(',');
  if (!url.startsWith('data:image/svg+xml') || comma < 0) throw new Error('Plotly did not return an SVG image.');
  return url.slice(0, comma).includes(';base64') ? atob(url.slice(comma + 1)) : decodeURIComponent(url.slice(comma + 1));
}

async function svgToPng(svg, width, height) {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('The browser could not create a figure canvas.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('The browser could not encode the PNG.')), 'image/png'));
    return new Blob([withPngDpi(await blob.arrayBuffer(), 600)], { type: 'image/png' });
  } finally { URL.revokeObjectURL(url); }
}

export async function exportChart(element, format, { filename, widthInches, heightInches }) {
  checkDimensions(widthInches, heightInches);
  if (!['png', 'svg'].includes(format)) throw new Error('Choose PNG or SVG.');
  if (!globalThis.Plotly || !element?.data || !element?.layout) throw new Error('The chart is not ready for export.');
  const width = widthInches * 96;
  const height = heightInches * 96;
  const data = JSON.parse(JSON.stringify(element.data));
  const layout = JSON.parse(JSON.stringify(element.layout));
  Object.assign(layout, { width, height, autosize: false, paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff', font: { family: 'Arial', size: 40 / 3, color: '#20251f' } });
  for (const key of Object.keys(layout).filter((key) => /^(x|y)axis\d*$/.test(key))) {
    Object.assign(layout[key], { showline: true, mirror: true, linecolor: '#20251f', linewidth: 1.6, showgrid: false, zeroline: false, tickfont: { family: 'Arial', size: 40 / 3 }, automargin: true });
    if (layout[key].title) layout[key].title.font = { family: 'Arial', size: 44 / 3 };
  }
  layout.legend = { ...layout.legend, bgcolor: '#ffffff', bordercolor: '#444444', borderwidth: .8, font: { family: 'Arial', size: 12 } };
  for (const trace of data) {
    if (trace.line) trace.line.width = 8 / 3;
    if (trace.marker?.colorbar) {
      trace.marker.colorbar.tickfont = { family: 'Arial', size: 40 / 3 };
      if (trace.marker.colorbar.title) trace.marker.colorbar.title.font = { family: 'Arial', size: 44 / 3 };
    }
  }
  const temporary = document.createElement('div');
  temporary.style.cssText = `position:fixed;left:-20000px;top:0;width:${width}px;height:${height}px;pointer-events:none`;
  document.body.append(temporary);
  try {
    await Plotly.newPlot(temporary, data, layout, { staticPlot: true, displayModeBar: false });
    const legend = temporary.querySelector('.legend');
    if (legend) {
      const bounds = legend.getBoundingClientRect();
      const container = temporary.getBoundingClientRect();
      if (bounds.left < container.left - 1 || bounds.top < container.top - 1 || bounds.right > container.right + 1 || bounds.bottom > container.bottom + 1) throw new Error('The figure legend falls outside the export canvas.');
    }
    const svg = svgPhysicalSize(decodeSvgUrl(await Plotly.toImage(temporary, { format: 'svg', width, height })), widthInches, heightInches);
    const blob = format === 'svg' ? new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }) : await svgToPng(svg, Math.round(widthInches * 600), Math.round(heightInches * 600));
    downloadBlob(`${filename}.${format}`, blob);
  } finally { Plotly.purge(temporary); temporary.remove(); }
}
