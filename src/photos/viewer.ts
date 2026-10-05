import { t } from '../i18n';

/** Open the original image in an independent, touch-friendly modal. */
export function openPhotoViewer(source: string): void {
  const dialog = document.createElement('dialog');
  dialog.className = 'photo-viewer';
  dialog.setAttribute('aria-label', t('Enlarged photo'));
  const toolbar = document.createElement('div');
  toolbar.className = 'photo-viewer-toolbar';
  const stage = document.createElement('div');
  stage.className = 'photo-viewer-stage';
  const image = document.createElement('img');
  image.src = source;
  image.alt = t('Enlarged photo');
  image.draggable = false;
  stage.append(image);
  let scale = 1, x = 0, y = 0;
  const pointers = new Map<number, { x: number; y: number }>();
  const render = () => { image.style.transform = `translate(${x}px, ${y}px) scale(${scale})`; };
  const zoom = (factor: number, pointX = 0, pointY = 0) => {
    const next = Math.max(1, Math.min(8, scale * factor));
    const ratio = next / scale;
    x = pointX - (pointX - x) * ratio;
    y = pointY - (pointY - y) * ratio;
    scale = next;
    if (scale === 1) x = y = 0;
    render();
  };
  const button = (label: string, action: () => void) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn'; b.textContent = t(label);
    b.addEventListener('click', action); toolbar.append(b);
  };
  button('Zoom out', () => zoom(1 / 1.5));
  button('Zoom in', () => zoom(1.5));
  button('Reset zoom', () => { scale = 1; x = y = 0; render(); });
  button('Close', () => dialog.close());
  const hint = document.createElement('p');
  hint.className = 'photo-viewer-hint';
  hint.textContent = t('Pinch to zoom. Drag to move the photo.');
  dialog.append(toolbar, stage, hint);
  const center = () => {
    const rect = stage.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  };
  stage.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    stage.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  });
  stage.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    const before = [...pointers.values()];
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const after = [...pointers.values()];
    if (before.length === 1) {
      if (scale > 1) { x += after[0].x - before[0].x; y += after[0].y - before[0].y; render(); }
    } else if (before.length === 2) {
      const distance = (p: typeof before) => Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      const c = center();
      const oldX = (before[0].x + before[1].x) / 2 - c.x;
      const oldY = (before[0].y + before[1].y) / 2 - c.y;
      const previous = distance(before);
      if (previous > 0) zoom(distance(after) / previous, oldX, oldY);
      if (scale > 1) {
        x += (after[0].x + after[1].x - before[0].x - before[1].x) / 2;
        y += (after[0].y + after[1].y - before[0].y - before[1].y) / 2;
        render();
      }
    }
  });
  const release = (event: PointerEvent) => pointers.delete(event.pointerId);
  stage.addEventListener('pointerup', release);
  stage.addEventListener('pointercancel', release);
  stage.addEventListener('lostpointercapture', release);
  stage.addEventListener('wheel', (event) => {
    event.preventDefault();
    const c = center();
    zoom(Math.exp(-event.deltaY * 0.002), event.clientX - c.x, event.clientY - c.y);
  }, { passive: false });
  stage.addEventListener('dblclick', () => scale > 1 ? (scale = 1, x = y = 0, render()) : zoom(2));
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
}

export function enablePhotoViewer(image: HTMLImageElement): void {
  image.classList.add('photo-zoomable');
  const parentButton = image.closest('button');
  if (!parentButton) { image.tabIndex = 0; image.setAttribute('role', 'button'); }
  image.setAttribute('aria-label', t('Enlarge photo'));
  const open = (event: Event) => { if (!parentButton) event.stopPropagation(); openPhotoViewer(image.src); };
  image.addEventListener('click', open);
  image.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(event); }
  });
}
