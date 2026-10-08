// Demo panel helpers: layer tabs, value read-outs, toggles.

export const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

/** The checkbox switching a layer on and off (`data-toggle` in the layer list). */
export const toggle = (layer: string) =>
  document.querySelector<HTMLInputElement>(`[data-toggle="${layer}"]`)!;

/** Layer tabs: selecting a layer shows its controls and hides the others. */
export function initTabs(initial: string): (layer: string) => void {
  const select = (layer: string) => {
    for (const tab of document.querySelectorAll<HTMLElement>('[data-tab]'))
      tab.classList.toggle('active', tab.dataset.tab === layer);
    for (const section of document.querySelectorAll<HTMLElement>('[data-controls]'))
      section.hidden = section.dataset.controls !== layer;
  };
  for (const tab of document.querySelectorAll<HTMLElement>('[data-tab]'))
    tab.addEventListener('click', () => select(tab.dataset.tab!));
  select(initial);
  return select;
}

/** A range input whose value shows in its label's `<output>`; `onInput` gets every change. */
export function range(
  id: string,
  onInput: (value: number) => void,
  format: (value: number) => string = String,
): { value(): number; set(value: number): void } {
  const input = $<HTMLInputElement>(id);
  const output = input.closest('label')?.querySelector('output');
  const show = () => {
    if (output) output.textContent = format(Number(input.value));
  };
  input.addEventListener('input', () => {
    show();
    onInput(Number(input.value));
  });
  show();
  return {
    value: () => Number(input.value),
    set(value: number) {
      input.value = String(value);
      show();
    },
  };
}

/** Mark the tabs of layers that are on (a dot), from their switches. */
export function syncTabDots(): void {
  for (const tab of document.querySelectorAll<HTMLElement>('[data-tab]')) {
    const input = document.querySelector<HTMLInputElement>(`[data-toggle="${tab.dataset.tab}"]`);
    tab.classList.toggle('on', !!input?.checked);
  }
}

/** The header button folds the panel down to its title bar. */
export function initCollapse(): void {
  const button = $('collapse');
  const panel = $('panel');
  button.addEventListener('click', () => {
    const collapsed = panel.classList.toggle('collapsed');
    button.setAttribute('aria-expanded', String(!collapsed));
    button.title = collapsed ? 'Expand panel' : 'Collapse panel';
  });
}
