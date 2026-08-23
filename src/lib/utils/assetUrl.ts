/**
 * Resolves a path under `public/` against the base the app is deployed at.
 *
 * GitHub Pages serves a project repository from a subpath
 * (`https://user.github.io/reactor2-optimizer/`), so a literal `/icons/x.webp`
 * resolves against the *domain* root and 404s. Vite rebases the asset
 * references it can see -- `url()` in component CSS, imported modules -- but a
 * URL assembled as a string at runtime is invisible to it, so it ships with the
 * leading slash intact. This is that missing rebase.
 *
 * `base` is `'./'` (see vite.config.ts), which makes `BASE_URL` relative to the
 * page rather than to a host that has to be known at build time -- the same
 * bundle works on Pages, on a custom domain and on localhost.
 */
export function asset(path: string): string {
  return `${import.meta.env.BASE_URL}${path.replace(/^\/+/, "")}`;
}
