// The site-wide background artwork, behind everything. Fixed in place while the page scrolls, click-through and
// hidden from assistive tech. The picture is pale grey, so it takes the theme in two ways (see .site-bg in
// index.css): a layer of the theme's own colour blended over it, and — in dark mode — the picture is inverted
// and held back, so it never glows white on a dark page. Each page's own cards and bars sit on top as usual.
export default function SiteBackground() {
  return (
    <div aria-hidden="true" className="site-bg">
      <div className="site-bg-art" />
      <div className="site-bg-tint" />
    </div>
  );
}
