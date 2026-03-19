import type { HistoryView } from '../../state/store';

function formatHistoryTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderHistoryPanel(
  history: HistoryView,
  handlers: { onJumpToHistory: (index: number) => void }
): void {
  const list = document.getElementById('history-list');
  const status = document.getElementById('history-panel-status');
  const undoBtn = document.getElementById('undo-btn') as HTMLButtonElement | null;
  const redoBtn = document.getElementById('redo-btn') as HTMLButtonElement | null;

  if (undoBtn) {
    undoBtn.disabled = !history.canUndo;
  }
  if (redoBtn) {
    redoBtn.disabled = !history.canRedo;
  }

  if (status) {
    status.textContent = history.entries.length === 0 ? '0 / 0' : `${history.index + 1} / ${history.entries.length}`;
  }

  if (!list) {
    return;
  }

  const items = history.entries
    .map((entry, index) => ({ ...entry, index }))
    .reverse();

  list.innerHTML = items
    .map((entry) => `
      <button class="history-item ${entry.index === history.index ? 'active' : ''}" data-history-index="${entry.index}" type="button">
        <span class="history-item-main">
          <span class="history-item-label">${escapeHtml(entry.label)}</span>
          <span class="history-item-time">${formatHistoryTimestamp(entry.timestamp)}</span>
        </span>
        <span class="history-item-index">#${entry.index + 1}</span>
      </button>
    `)
    .join('');

  list.querySelectorAll('.history-item').forEach((button) => {
    button.addEventListener('click', () => {
      const index = Number((button as HTMLElement).dataset.historyIndex);
      if (Number.isFinite(index)) {
        handlers.onJumpToHistory(index);
      }
    });
  });
}
