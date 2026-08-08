<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { marked } from 'marked'
import { docsPathFromUrl, docsUrl, isMarkdownPath } from '../../../../shared/docs'
import { back, canGoBack, currentPath, home, navigate } from './session'
import Icon from '../../components/Icon.vue'

const html = ref('')
const error = ref<string | null>(null)
const scroller = ref<HTMLDivElement>()

const title = computed(() => currentPath.value.replace(/\.(md|markdown)$/i, ''))

/**
 * Rewrites a rendered page's links so they point at the scheme.
 *
 * The markdown is written for GitHub, where every path is relative to the file
 * it sits in — `images/x.png` from `docs/`, `../images/x.png` from
 * `docs/tutorials/`. Resolving each one against the *page's* own `docs://` URL
 * reproduces exactly that, so the same sources render correctly in both places
 * and nothing has to be rewritten on disk.
 */
function resolveLinks(markup: string, pagePath: string): string {
  const base = docsUrl(pagePath)
  const doc = new DOMParser().parseFromString(markup, 'text/html')

  for (const img of doc.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src') ?? ''
    if (/^[a-z][a-z0-9+.-]*:/i.test(src)) continue // already absolute
    img.setAttribute('src', new URL(src, base).toString())
  }

  for (const anchor of doc.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href') ?? ''
    if (href.startsWith('#')) continue // in-page anchor, left to the browser

    const absolute = new URL(href, base).toString()
    const docPath = docsPathFromUrl(absolute)
    if (docPath && isMarkdownPath(docPath)) {
      // Another page: navigate in place. The href is dropped so a stray
      // middle-click can't send the whole window to a docs:// URL.
      anchor.setAttribute('data-doc', docPath)
      anchor.removeAttribute('href')
    } else if (docPath) {
      // A non-page file that ships with the docs — an image opened directly.
      anchor.setAttribute('data-doc-asset', absolute)
      anchor.removeAttribute('href')
    } else {
      anchor.setAttribute('data-external', absolute)
      anchor.removeAttribute('href')
    }
  }

  return doc.body.innerHTML
}

async function load(path: string): Promise<void> {
  error.value = null
  try {
    const response = await fetch(docsUrl(path))
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
    html.value = resolveLinks(await marked.parse(await response.text()), path)
    // A fresh page starts at the top; the scroller is reused across pages.
    if (scroller.value) scroller.value.scrollTop = 0
  } catch (cause) {
    html.value = ''
    error.value = `Could not open ${path} — ${cause instanceof Error ? cause.message : String(cause)}`
  }
}

watch(currentPath, (path) => void load(path), { immediate: true })

/** One delegated handler — the rendered HTML is replaced wholesale on navigation. */
function onClick(event: MouseEvent): void {
  const anchor = (event.target as HTMLElement).closest('a')
  if (!anchor) return

  const docPath = anchor.getAttribute('data-doc')
  const asset = anchor.getAttribute('data-doc-asset')
  const external = anchor.getAttribute('data-external')

  if (docPath) {
    event.preventDefault()
    navigate(docPath)
  } else if (external || asset) {
    event.preventDefault()
    // `docs://` assets live inside the asar, so there is no path to hand the
    // OS — open those in the browser, which speaks the scheme.
    void window.api.invoke('shell:open', { target: external ?? asset ?? '' })
  }
}
</script>

<template>
  <div class="docs-tab">
    <div class="toolbar">
      <button
        type="button"
        title="Back"
        :disabled="!canGoBack"
        @click="back()"
      >
        <Icon name="arrow_back" />
      </button>
      <button
        type="button"
        title="Contents"
        @click="home()"
      >
        <Icon name="home" />
      </button>
      <span class="path">{{ title }}</span>
    </div>

    <div
      ref="scroller"
      class="page"
      @click="onClick"
    >
      <p
        v-if="error"
        class="error"
      >
        {{ error }}
      </p>
      <!-- eslint-disable vue/no-v-html -- the docs are the app's own source,
           shipped in the asar and served from a scheme only we answer; there is
           no untrusted input on this path. Raw HTML in the markdown (the
           centred <img> blocks in the demo READMEs) has to survive. -->
      <article
        v-else
        class="markdown"
        v-html="html"
      />
      <!-- eslint-enable vue/no-v-html -->
    </div>
  </div>
</template>

<style scoped>
.docs-tab {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-editor);
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--color-border);
  flex: 0 0 auto;
}

.toolbar button {
  display: flex;
  align-items: center;
  padding: 4px;
  border-radius: 4px;
  color: var(--color-text);
}

.toolbar button:hover:not(:disabled) {
  background: var(--color-bg-hover);
}

.toolbar button:disabled {
  opacity: 0.4;
  cursor: default;
}

.path {
  margin-left: 4px;
  color: var(--color-text-muted);
  font-size: 12px;
}

.page {
  flex: 1 1 auto;
  overflow: auto;
  padding: 24px 32px 64px;
}

.error {
  color: var(--color-error);
}

/* A reading column: prose is unreadable at a maximised window's full width. */
.markdown {
  max-width: 46rem;
  margin: 0 auto;
  line-height: 1.6;
}

.markdown :deep(h1),
.markdown :deep(h2),
.markdown :deep(h3),
.markdown :deep(h4) {
  line-height: 1.25;
  margin: 1.6em 0 0.6em;
}

.markdown :deep(h1) {
  font-size: 1.9em;
  margin-top: 0;
}
.markdown :deep(h2) {
  font-size: 1.4em;
  padding-bottom: 0.3em;
  border-bottom: 1px solid var(--color-border);
}
.markdown :deep(h3) {
  font-size: 1.15em;
}

.markdown :deep(a) {
  color: var(--color-accent);
  cursor: pointer;
  text-decoration: none;
}
.markdown :deep(a:hover) {
  text-decoration: underline;
}

/* Screenshots are 1400px wide; without this they force the page to scroll sideways. */
.markdown :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: 6px;
}

.markdown :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.9em;
  padding: 0.15em 0.35em;
  border-radius: 4px;
  background: var(--color-bg-hover);
}

.markdown :deep(pre) {
  padding: 12px 14px;
  border-radius: 6px;
  border: 1px solid var(--color-border);
  background: var(--color-bg-sidebar);
  overflow-x: auto;
}

.markdown :deep(pre code) {
  padding: 0;
  background: none;
}

.markdown :deep(blockquote) {
  margin: 1em 0;
  padding: 0.1em 1em;
  border-left: 3px solid var(--color-border);
  color: var(--color-text-muted);
}

.markdown :deep(table) {
  border-collapse: collapse;
  margin: 1em 0;
  display: block;
  overflow-x: auto;
}

.markdown :deep(th),
.markdown :deep(td) {
  border: 1px solid var(--color-border);
  padding: 6px 10px;
  text-align: left;
}

.markdown :deep(th) {
  background: var(--color-bg-hover);
}

.markdown :deep(hr) {
  border: none;
  border-top: 1px solid var(--color-border);
  margin: 2em 0;
}
</style>
