// plotly.js ships no types of its own, and none at all for the `lib/` entry points a custom
// bundle is assembled from (see `src/lib/plotly.ts`). Rather than let `any` spread from the
// import site through every component prop, this declares the four methods the app actually
// calls. Trace and layout objects stay loose — Plotly's schema is enormous and largely
// dynamic — but the *surface* is pinned, so a mistyped method name becomes a compile error.
declare module 'plotly.js/lib/core' {
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

// Trace modules are opaque registry payloads: the only thing done with them is handing them
// to `Plotly.register`, which takes `unknown`.
declare module 'plotly.js/lib/scatter' {
	const traceModule: unknown;
	export default traceModule;
}
declare module 'plotly.js/lib/bar' {
	const traceModule: unknown;
	export default traceModule;
}
declare module 'plotly.js/lib/heatmap' {
	const traceModule: unknown;
	export default traceModule;
}
declare module 'plotly.js/lib/contour' {
	const traceModule: unknown;
	export default traceModule;
}
