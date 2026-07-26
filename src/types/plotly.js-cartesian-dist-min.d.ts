// The cartesian bundle rather than the full one: it registers scatter, bar and heatmap —
// every trace this app draws — while excluding the geo, mapbox and gl modules. That drops
// the bundle from 4.7 MB to 1.4 MB and, with it, every map-tile host (mapbox, OpenStreetMap,
// carto, openmaptiles) that the full build carries in its geo code. See README §1 Privacy.
//
// plotly.js ships no types with this bundle. Rather than let `any` spread from the import
// site through every component prop, this declares the four methods the app actually calls.
// Trace and layout objects stay loose — Plotly's schema is enormous and largely dynamic —
// but the *surface* is pinned, so a mistyped method name becomes a compile error.
declare module 'plotly.js-cartesian-dist-min' {
	export type PlotlyTrace = Record<string, unknown>;
	export type PlotlyLayout = Record<string, unknown>;
	export type PlotlyConfig = Record<string, unknown>;

	export type PlotlyShape = Record<string, unknown>;
	export type PlotlyAnnotation = Record<string, unknown>;

	/** Plotly attaches its event emitter to the container element it renders into. */
	export interface PlotlyHTMLElement extends HTMLElement {
		on(event: string, handler: (eventData: Record<string, unknown>) => unknown): void;
	}

	export interface PlotlyApi {
		react(
			element: HTMLElement,
			data: PlotlyTrace[],
			layout?: PlotlyLayout,
			config?: PlotlyConfig
		): Promise<unknown>;
		relayout(element: HTMLElement, update: PlotlyLayout): Promise<unknown>;
		purge(element: HTMLElement): void;
		register(modules: unknown): void;
		/** Built-in modebar icons; present on the bundle but not part of the documented API. */
		readonly Icons?: Record<string, unknown>;
	}

	const Plotly: PlotlyApi;
	export default Plotly;
}
