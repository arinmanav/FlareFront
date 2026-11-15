export function bindMonthControls(document, { getSelection, onSelect, onShift }) {
  const groups = [['selected-month', 'previous-month', 'next-month'], ['daily-month', 'daily-previous-month', 'daily-next-month']];
  function update() {
    const { selected, start, end } = getSelection();
    for (const [input, previous, next] of groups) {
      Object.assign(document.getElementById(input), { value: selected, min: start, max: end });
      document.getElementById(previous).disabled = selected <= start;
      document.getElementById(next).disabled = selected >= end;
    }
  }
  for (const [input, previous, next] of groups) {
    document.getElementById(input).addEventListener('change', (event) => { onSelect(event.target.value); update(); });
    document.getElementById(previous).addEventListener('click', () => { if (!document.getElementById(previous).disabled) onShift(-1); update(); });
    document.getElementById(next).addEventListener('click', () => { if (!document.getElementById(next).disabled) onShift(1); update(); });
  }
  return { update };
}
