import { Marked } from './vendor/marked.js';
import DOMPurify from './vendor/purify.js';

const parser = new Marked({ gfm: true, breaks: true });

// Treat embedded HTML as text; model output must never become application UI.
parser.use({ renderer: {
  html({ text }) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },
} });

export function renderMarkdown(element, source) {
  const html = parser.parse(String(source || ''));
  const fragment = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'strong', 'em', 'del', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code',
      'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input'],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'start', 'align',
      'type', 'checked', 'disabled'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  });
  for (const link of fragment.querySelectorAll('a[href]')) {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
  for (const image of fragment.querySelectorAll('img')) {
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
  }
  for (const input of fragment.querySelectorAll('input')) {
    input.type = 'checkbox';
    input.disabled = true;
  }
  element.classList.add('markdown-body');
  element.replaceChildren(fragment);
}
