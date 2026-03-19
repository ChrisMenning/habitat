/**
 * health.js — Server-side API key health check and missing-key banner.
 *
 * Fetches /api/health on startup and inserts a dismissible warning banner
 * directly below the header if any optional API keys are not configured.
 * The banner is suppressed for the rest of the session once dismissed.
 */

/**
 * Checks /api/health and, if any keys are missing, renders a warning banner
 * below the main app header. Call once after the DOM is ready.
 */
export async function initHealthCheck() {
  // Don't re-show if the user dismissed it this session
  if (sessionStorage.getItem('bayhive-health-dismissed')) return;

  let data;
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (!res.ok) return;
    data = await res.json();
  } catch {
    return; // server not running health endpoint — degrade silently
  }

  const missing = Object.entries(data.keys ?? {}).filter(([, v]) => !v.present);
  if (missing.length === 0) return;

  const banner = document.createElement('div');
  banner.id = 'health-banner';
  banner.setAttribute('role', 'alert');
  banner.setAttribute('aria-live', 'polite');

  const items = missing.map(([envKey, v]) =>
    `<span class="hb-item">` +
      `<a class="hb-link" href="${_safeUrl(v.url)}" target="_blank" rel="noopener noreferrer">${_esc(v.system)}</a>` +
      `\u00a0<code class="hb-code">${_esc(envKey)}</code>` +
    `</span>`
  );

  banner.innerHTML =
    `<span class="hb-icon" aria-hidden="true">⚠️</span>` +
    `<div class="hb-msg">` +
      `<strong>${missing.length} API key${missing.length > 1 ? 's' : ''} not configured</strong>` +
      ` \u2014 affected features: ${items.join(' \u00b7 ')}.` +
      ` Add keys to <code>api-keys.txt</code> in the project root, then restart the server.` +
    `</div>` +
    `<button class="hb-close" aria-label="Dismiss API key warning">\u2715</button>`;

  banner.querySelector('.hb-close').addEventListener('click', () => {
    banner.remove();
    sessionStorage.setItem('bayhive-health-dismissed', '1');
  });

  const header = document.getElementById('header');
  if (header) header.insertAdjacentElement('afterend', banner);
}

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _safeUrl(s) {
  const str = String(s ?? '');
  return /^https?:\/\//.test(str) ? str.replace(/"/g, '&quot;') : '#';
}
