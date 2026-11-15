import { logColorPosition } from './calendar.js';

export const FIRE_RAMP = ['#fcf1dc', '#f4c690', '#e79249', '#cc5b21', '#73321b'];
export const MISSING_COLOR = '#e5e7e1';

export function luminance(hex) {
  const channels = hex.match(/[a-f\d]{2}/gi).map((value) => parseInt(value, 16) / 255)
    .map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}

export function fireColor(value, maximum) {
  if (value === null) return MISSING_COLOR;
  const position = Math.max(0, Math.min(1, logColorPosition(value, maximum))) * (FIRE_RAMP.length - 1);
  const low = Math.min(Math.floor(position), FIRE_RAMP.length - 2), fraction = position - low;
  const channels = [FIRE_RAMP[low], FIRE_RAMP[low + 1]].map((hex) => hex.match(/[a-f\d]{2}/gi).map((channel) => parseInt(channel, 16)));
  return `#${channels[0].map((channel, index) => Math.round(channel + (channels[1][index] - channel) * fraction).toString(16).padStart(2, '0')).join('')}`;
}

export function cellTextColor(background) {
  const light = luminance(background);
  return (light + .05) / .05 >= 1.05 / (light + .05) ? '#000000' : '#ffffff';
}
