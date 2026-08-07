/**
 * The Plotly bundle this app ships: `plotly.js/lib/core` plus exactly the four traces the
 * charts draw. Everything else Plotly can render — geo, mapbox, gl3d, gl2d, finance, polar,
 * ternary, pie/sunburst/treemap, box, violin, funnel, waterfall, indicator, carpet — is
 * never imported, so it is never in the output.
 *
 * This replaces the prebuilt `plotly.js-cartesian-dist-min`, which registers a fixed set of
 * ~20 cartesian traces regardless of use. Comparing what actually ships — the emitted Vite
 * chunk, before and after — dropping the unused traces takes it from 1.49 MB / 434 KB
 * gzipped to 1.12 MB / 370 KB, about 65 KB off the wire. (Against the prebuilt dist file as
 * published, 1.42 MB / 461 KB, the gap looks larger; Vite re-minifies, so chunk-to-chunk is
 * the honest comparison.) The floor is `core` itself: cartesian axes, the component set
 * (shapes, annotations, legend, hover, modebar, colorbar) and Plotly's vendored d3 account
 * for the remainder, and none of it is tree-shakeable — core registers its components
 * unconditionally.
 *
 * The privacy property the cartesian bundle was chosen for in the first place holds a
 * fortiori: no geo, mapbox or map module is present, so no tile-host endpoint (mapbox,
 * OpenStreetMap, carto, openmaptiles) is reachable from the output. The word "mapbox" does
 * still appear in the chunk — `core` carries the config schema, which names every subplot
 * type in `scrollZoom`'s flag list and in help text — but no tile URL does. See README §1
 * Privacy.
 *
 * Which traces each chart needs, so this list can be pruned or extended deliberately:
 *   scatter — the timeline fan chart, and the marker overlay on the ruin surface
 *   bar     — the sequence-risk diagnostic
 *   heatmap — the ruin surface in spending-only mode; also a dependency of contour
 *   contour — the ruin surface in its two-axis mode
 *
 * Imported for its side effect of registering the traces, then re-exported: callers use the
 * default export and never touch `plotly.js/lib/*` directly.
 */
import Plotly from 'plotly.js/lib/core';
import scatter from 'plotly.js/lib/scatter';
import bar from 'plotly.js/lib/bar';
import heatmap from 'plotly.js/lib/heatmap';
import contour from 'plotly.js/lib/contour';

Plotly.register([scatter, bar, heatmap, contour]);

export type {
	PlotlyAnnotation,
	PlotlyApi,
	PlotlyConfig,
	PlotlyHTMLElement,
	PlotlyLayout,
	PlotlyShape,
	PlotlyTrace
} from 'plotly.js/lib/core';

export default Plotly;
