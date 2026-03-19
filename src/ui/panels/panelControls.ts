import type { AppState } from '../../state/types';

export function updateSlider(id: string, value: number): void {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (el && document.activeElement !== el) {
    el.value = String(value);
  }

  const valEl = document.getElementById(`${id}-val`) as HTMLInputElement | null;
  if (valEl && document.activeElement !== valEl) {
    valEl.value = value.toFixed(2);
  }
}

export function updateNumberInput(id: string, value: number): void {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (el && document.activeElement !== el) {
    el.value = value.toFixed(4);
  }
}

export function updateMappingDetail(state: AppState): void {
  const detailPanel = document.getElementById('mapping-detail');
  if (!detailPanel) return;

  const sel = state.ui.selectedMappingId;
  const mapping = sel ? state.localMappings.find((m) => m.id === sel) : null;

  if (mapping) {
    detailPanel.style.display = 'block';
    updateSlider('mapping-src-slider', mapping.srcHue);
    updateSlider('mapping-dst-slider', mapping.dstHue);
    updateSlider('mapping-range-slider', mapping.range);
    updateSlider('mapping-strength-slider', mapping.strength);
  } else {
    detailPanel.style.display = 'none';
  }
}

export function updateMappingList(
  state: AppState,
  handlers: { onSelectMapping: (id: string) => void }
): void {
  const list = document.getElementById('mapping-list');
  if (!list) return;

  list.innerHTML = state.localMappings.map((m) => {
    const srcDeg = Math.round(m.srcHue * 360);
    const dstDeg = Math.round(m.dstHue * 360);
    const isSelected = state.ui.selectedMappingId === m.id;
    return `<div class="mapping-item ${isSelected ? 'selected' : ''}" data-id="${m.id}">
      <span class="mapping-color" style="background:hsl(${srcDeg},80%,50%)"></span>
      <span>${srcDeg}\u00b0 \u2192 ${dstDeg}\u00b0</span>
      <span class="mapping-range">${Math.round(m.range * 360)}\u00b0</span>
    </div>`;
  }).join('');

  list.querySelectorAll('.mapping-item').forEach((item) => {
    item.addEventListener('click', () => {
      const id = (item as HTMLElement).dataset.id;
      if (id) {
        handlers.onSelectMapping(id);
      }
    });
  });
}
