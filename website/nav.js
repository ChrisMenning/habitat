/**
 * nav.js — Shared navigation web component for Bay Hive informational pages.
 *
 * Usage: add <script src="nav.js" defer></script> in <head> and place
 * <bh-nav></bh-nav> at the top of <body> in place of the inline <nav>.
 *
 * The component automatically marks the current page's link with
 * aria-current="page" based on location.pathname, and wires up the
 * mobile hamburger toggle.
 */

class BhNav extends HTMLElement {
  connectedCallback() {
    const path = location.pathname;

    const item = (href, label, cls) => {
      const isActive = href === '/' ? path === '/' : path === href;
      const current  = isActive ? ' aria-current="page"' : '';
      const klass    = cls ? ` class="${cls}"` : '';
      return `<li><a href="${href}"${klass}${current}>${label}</a></li>`;
    };

    this.innerHTML = `
<nav role="navigation" aria-label="Main navigation">
  <a href="/" class="nav-wordmark" aria-label="Bay Hive home">
    <span class="w1">Bay</span>
    <span class="w2">Hive</span>
    <span class="wh">&#x2B21;</span>
  </a>
  <button class="nav-hamburger" id="nav-toggle"
          aria-label="Open navigation menu" aria-expanded="false"
          aria-controls="nav-links-list">
    <span></span><span></span><span></span>
  </button>
  <ul class="nav-links" id="nav-links-list">
    ${item('/', 'Overview')}
    ${item('/guide.html', 'Map Guide')}
    ${item('/reference.html', 'Reference')}
    ${item('/app', 'Launch &#x2197;', 'nav-cta')}
  </ul>
</nav>`;

    const toggle = this.querySelector('#nav-toggle');
    const list   = this.querySelector('#nav-links-list');

    if (!toggle || !list) return;

    toggle.addEventListener('click', () => {
      const isOpen = list.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      toggle.setAttribute('aria-label', isOpen ? 'Close navigation menu' : 'Open navigation menu');
    });

    list.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', () => {
        list.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-label', 'Open navigation menu');
      });
    });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && list.classList.contains('is-open')) {
        list.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-label', 'Open navigation menu');
        toggle.focus();
      }
    });
  }
}

customElements.define('bh-nav', BhNav);
