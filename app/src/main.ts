// The page is a document first. The importer is a large dependency -- the
// atproto client and its crypto -- so it is fetched only when a reader
// actually reaches it, or immediately if they arrived at #import or are
// returning from an OAuth redirect.
const mount = document.getElementById('app')
if (mount) {
  const load = () => import('./importer.ts').then((m) => m.start())
  const returningFromOAuth = /[?#].*\b(code|state|error)=/.test(location.href)
  if (returningFromOAuth || location.hash === '#import') {
    void load()
  } else {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          observer.disconnect()
          void load()
        }
      },
      { rootMargin: '400px' },
    )
    observer.observe(mount)
  }
}
