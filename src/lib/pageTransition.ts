// Smooth cross-page fade. Imported by every scene page. On load it fades a
// deep-space cover out to reveal the scene; on an internal link click it fades
// the cover back in, then navigates — so moving between scenes feels seamless.
// Uses full navigations (each scene re-initialises WebGL cleanly), hidden
// behind the fade.

const cover = document.createElement('div');
cover.className = 'page-fade';
document.documentElement.appendChild(cover);

function reveal() {
  // double rAF so the initial opaque state is painted before we transition out
  requestAnimationFrame(() =>
    requestAnimationFrame(() => cover.classList.add('page-fade--hidden'))
  );
}
reveal();
// Restore on back/forward (bfcache) navigation.
window.addEventListener('pageshow', reveal);

document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const link = (e.target as HTMLElement).closest('a');
  if (!link) return;
  const href = link.getAttribute('href');
  if (!href || link.target === '_blank' || link.hasAttribute('download')) return;

  const url = new URL(href, location.href);
  if (url.origin !== location.origin || url.pathname === location.pathname) return;

  e.preventDefault();
  cover.classList.remove('page-fade--hidden');
  window.setTimeout(() => { location.href = url.href; }, 420);
});
