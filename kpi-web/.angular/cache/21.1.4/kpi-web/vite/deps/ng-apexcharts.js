import {
  isPlatformBrowser
} from "./chunk-AWGENM2K.js";
import "./chunk-CQMO4W7L.js";
import {
  ChangeDetectionStrategy,
  Component,
  Injector,
  Input,
  NgModule,
  NgZone,
  Output,
  PLATFORM_ID,
  ViewChild,
  afterEveryRender,
  afterNextRender,
  inject,
  input,
  output,
  setClassMetadata,
  signal,
  viewChild,
  ɵɵNgOnChangesFeature,
  ɵɵdefineComponent,
  ɵɵdefineInjector,
  ɵɵdefineNgModule,
  ɵɵdomElement,
  ɵɵqueryAdvance,
  ɵɵviewQuerySignal
} from "./chunk-CXZUV7CW.js";
import "./chunk-3W2H5XLE.js";
import "./chunk-EOM55H4P.js";
import "./chunk-7PGV35JJ.js";
import "./chunk-GOMI4DH3.js";

// ../node_modules/ng-apexcharts/fesm2022/ng-apexcharts.mjs
var _c0 = ["chart"];
var ChartComponent = class _ChartComponent {
  constructor() {
    this.chart = input(...ngDevMode ? [void 0, {
      debugName: "chart"
    }] : []);
    this.annotations = input(...ngDevMode ? [void 0, {
      debugName: "annotations"
    }] : []);
    this.colors = input(...ngDevMode ? [void 0, {
      debugName: "colors"
    }] : []);
    this.dataLabels = input(...ngDevMode ? [void 0, {
      debugName: "dataLabels"
    }] : []);
    this.series = input(...ngDevMode ? [void 0, {
      debugName: "series"
    }] : []);
    this.stroke = input(...ngDevMode ? [void 0, {
      debugName: "stroke"
    }] : []);
    this.labels = input(...ngDevMode ? [void 0, {
      debugName: "labels"
    }] : []);
    this.legend = input(...ngDevMode ? [void 0, {
      debugName: "legend"
    }] : []);
    this.markers = input(...ngDevMode ? [void 0, {
      debugName: "markers"
    }] : []);
    this.noData = input(...ngDevMode ? [void 0, {
      debugName: "noData"
    }] : []);
    this.parsing = input(...ngDevMode ? [void 0, {
      debugName: "parsing"
    }] : []);
    this.fill = input(...ngDevMode ? [void 0, {
      debugName: "fill"
    }] : []);
    this.tooltip = input(...ngDevMode ? [void 0, {
      debugName: "tooltip"
    }] : []);
    this.plotOptions = input(...ngDevMode ? [void 0, {
      debugName: "plotOptions"
    }] : []);
    this.responsive = input(...ngDevMode ? [void 0, {
      debugName: "responsive"
    }] : []);
    this.xaxis = input(...ngDevMode ? [void 0, {
      debugName: "xaxis"
    }] : []);
    this.yaxis = input(...ngDevMode ? [void 0, {
      debugName: "yaxis"
    }] : []);
    this.forecastDataPoints = input(...ngDevMode ? [void 0, {
      debugName: "forecastDataPoints"
    }] : []);
    this.grid = input(...ngDevMode ? [void 0, {
      debugName: "grid"
    }] : []);
    this.states = input(...ngDevMode ? [void 0, {
      debugName: "states"
    }] : []);
    this.title = input(...ngDevMode ? [void 0, {
      debugName: "title"
    }] : []);
    this.subtitle = input(...ngDevMode ? [void 0, {
      debugName: "subtitle"
    }] : []);
    this.theme = input(...ngDevMode ? [void 0, {
      debugName: "theme"
    }] : []);
    this.autoUpdateSeries = input(true, ...ngDevMode ? [{
      debugName: "autoUpdateSeries"
    }] : []);
    this.chartReady = output();
    this.chartInstance = signal(null, ...ngDevMode ? [{
      debugName: "chartInstance"
    }] : []);
    this.chartElement = viewChild.required("chart");
    this.ngZone = inject(NgZone);
    this.isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
    this._destroyed = false;
    this._injector = inject(Injector);
    this.waitingForConnectedRef = null;
  }
  ngOnChanges(changes) {
    if (!this.isBrowser) return;
    this.hydrate(changes);
  }
  ngOnDestroy() {
    this.destroy();
    this._destroyed = true;
  }
  /** Determine if the host element is connected to the document */
  get isConnected() {
    return this.chartElement()?.nativeElement.isConnected;
  }
  hydrate(changes) {
    if (this.waitingForConnectedRef) {
      return;
    }
    const shouldUpdateSeries = this.chartInstance() && this.autoUpdateSeries() && Object.keys(changes).filter((c) => c !== "series").length === 0;
    if (shouldUpdateSeries) {
      this.updateSeries(this.series(), true);
      return;
    }
    afterNextRender({
      read: () => this.createElement()
    }, {
      injector: this._injector
    });
  }
  async createElement() {
    const {
      default: ApexCharts
    } = await import("./apexcharts.esm-EDGAV4JX.js");
    window.ApexCharts ||= ApexCharts;
    if (this._destroyed) return;
    if (!this.isConnected) {
      this.waitForConnected();
      return;
    }
    const options = {};
    const properties = ["annotations", "chart", "colors", "dataLabels", "series", "stroke", "labels", "legend", "fill", "tooltip", "plotOptions", "responsive", "markers", "noData", "parsing", "xaxis", "yaxis", "forecastDataPoints", "grid", "states", "title", "subtitle", "theme"];
    properties.forEach((property) => {
      const value = this[property]();
      if (value) {
        options[property] = value;
      }
    });
    this.destroy();
    const chartInstance = this.ngZone.runOutsideAngular(() => new ApexCharts(this.chartElement().nativeElement, options));
    this.chartInstance.set(chartInstance);
    this.render();
    this.chartReady.emit({
      chartObj: chartInstance
    });
  }
  render() {
    if (this.isConnected) {
      return this.ngZone.runOutsideAngular(() => this.chartInstance()?.render());
    } else {
      this.waitForConnected();
    }
  }
  updateOptions(options, redrawPaths, animate, updateSyncedCharts) {
    return this.ngZone.runOutsideAngular(() => this.chartInstance()?.updateOptions(options, redrawPaths, animate, updateSyncedCharts));
  }
  updateSeries(newSeries, animate) {
    return this.ngZone.runOutsideAngular(() => this.chartInstance()?.updateSeries(newSeries, animate));
  }
  appendSeries(newSeries, animate) {
    this.ngZone.runOutsideAngular(() => this.chartInstance()?.appendSeries(newSeries, animate));
  }
  appendData(newData) {
    this.ngZone.runOutsideAngular(() => this.chartInstance()?.appendData(newData));
  }
  highlightSeries(seriesName) {
    return this.ngZone.runOutsideAngular(() => this.chartInstance()?.highlightSeries(seriesName));
  }
  toggleSeries(seriesName) {
    return this.ngZone.runOutsideAngular(() => this.chartInstance()?.toggleSeries(seriesName));
  }
  showSeries(seriesName) {
    this.ngZone.runOutsideAngular(() => this.chartInstance()?.showSeries(seriesName));
  }
  hideSeries(seriesName) {
    this.ngZone.runOutsideAngular(() => this.chartInstance()?.hideSeries(seriesName));
  }
  resetSeries() {
    this.ngZone.runOutsideAngular(() => this.chartInstance()?.resetSeries());
  }
  zoomX(min, max) {
    this.ngZone.runOutsideAngular(() => this.chartInstance()?.zoomX(min, max));
  }
  toggleDataPointSelection(seriesIndex, dataPointIndex) {
    this.ngZone.runOutsideAngular(() => this.chartInstance()?.toggleDataPointSelection(seriesIndex, dataPointIndex));
  }
  destroy() {
    this.chartInstance()?.destroy();
    this.chartInstance.set(null);
  }
  setLocale(localeName) {
    this.ngZone.runOutsideAngular(() => this.chartInstance()?.setLocale(localeName));
  }
  paper() {
    this.ngZone.runOutsideAngular(() => this.chartInstance()?.paper());
  }
  addXaxisAnnotation(options, pushToMemory, context) {
    this.ngZone.runOutsideAngular(() => this.chartInstance()?.addXaxisAnnotation(options, pushToMemory, context));
  }
  addYaxisAnnotation(options, pushToMemory, context) {
    this.ngZone.runOutsideAngular(() => this.chartInstance()?.addYaxisAnnotation(options, pushToMemory, context));
  }
  addPointAnnotation(options, pushToMemory, context) {
    this.ngZone.runOutsideAngular(() => this.chartInstance()?.addPointAnnotation(options, pushToMemory, context));
  }
  removeAnnotation(id, options) {
    this.ngZone.runOutsideAngular(() => this.chartInstance()?.removeAnnotation(id, options));
  }
  clearAnnotations(options) {
    this.ngZone.runOutsideAngular(() => this.chartInstance()?.clearAnnotations(options));
  }
  dataURI(options) {
    return this.chartInstance()?.dataURI(options);
  }
  waitForConnected() {
    if (this.waitingForConnectedRef) {
      return;
    }
    this.waitingForConnectedRef = afterEveryRender({
      read: () => {
        if (this.isConnected) {
          this.waitingForConnectedRef.destroy();
          this.waitingForConnectedRef = null;
          this.createElement();
        }
      }
    }, {
      injector: this._injector
    });
  }
  static {
    this.ɵfac = function ChartComponent_Factory(__ngFactoryType__) {
      return new (__ngFactoryType__ || _ChartComponent)();
    };
  }
  static {
    this.ɵcmp = ɵɵdefineComponent({
      type: _ChartComponent,
      selectors: [["apx-chart"]],
      viewQuery: function ChartComponent_Query(rf, ctx) {
        if (rf & 1) {
          ɵɵviewQuerySignal(ctx.chartElement, _c0, 5);
        }
        if (rf & 2) {
          ɵɵqueryAdvance();
        }
      },
      inputs: {
        chart: [1, "chart"],
        annotations: [1, "annotations"],
        colors: [1, "colors"],
        dataLabels: [1, "dataLabels"],
        series: [1, "series"],
        stroke: [1, "stroke"],
        labels: [1, "labels"],
        legend: [1, "legend"],
        markers: [1, "markers"],
        noData: [1, "noData"],
        parsing: [1, "parsing"],
        fill: [1, "fill"],
        tooltip: [1, "tooltip"],
        plotOptions: [1, "plotOptions"],
        responsive: [1, "responsive"],
        xaxis: [1, "xaxis"],
        yaxis: [1, "yaxis"],
        forecastDataPoints: [1, "forecastDataPoints"],
        grid: [1, "grid"],
        states: [1, "states"],
        title: [1, "title"],
        subtitle: [1, "subtitle"],
        theme: [1, "theme"],
        autoUpdateSeries: [1, "autoUpdateSeries"]
      },
      outputs: {
        chartReady: "chartReady"
      },
      features: [ɵɵNgOnChangesFeature],
      decls: 2,
      vars: 0,
      consts: [["chart", ""]],
      template: function ChartComponent_Template(rf, ctx) {
        if (rf & 1) {
          ɵɵdomElement(0, "div", null, 0);
        }
      },
      encapsulation: 2,
      changeDetection: 0
    });
  }
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(ChartComponent, [{
    type: Component,
    args: [{
      selector: "apx-chart",
      template: `<div #chart></div>`,
      changeDetection: ChangeDetectionStrategy.OnPush,
      standalone: true
    }]
  }], null, {
    chart: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "chart",
        required: false
      }]
    }],
    annotations: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "annotations",
        required: false
      }]
    }],
    colors: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "colors",
        required: false
      }]
    }],
    dataLabels: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "dataLabels",
        required: false
      }]
    }],
    series: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "series",
        required: false
      }]
    }],
    stroke: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "stroke",
        required: false
      }]
    }],
    labels: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "labels",
        required: false
      }]
    }],
    legend: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "legend",
        required: false
      }]
    }],
    markers: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "markers",
        required: false
      }]
    }],
    noData: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "noData",
        required: false
      }]
    }],
    parsing: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "parsing",
        required: false
      }]
    }],
    fill: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "fill",
        required: false
      }]
    }],
    tooltip: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "tooltip",
        required: false
      }]
    }],
    plotOptions: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "plotOptions",
        required: false
      }]
    }],
    responsive: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "responsive",
        required: false
      }]
    }],
    xaxis: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "xaxis",
        required: false
      }]
    }],
    yaxis: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "yaxis",
        required: false
      }]
    }],
    forecastDataPoints: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "forecastDataPoints",
        required: false
      }]
    }],
    grid: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "grid",
        required: false
      }]
    }],
    states: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "states",
        required: false
      }]
    }],
    title: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "title",
        required: false
      }]
    }],
    subtitle: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "subtitle",
        required: false
      }]
    }],
    theme: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "theme",
        required: false
      }]
    }],
    autoUpdateSeries: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "autoUpdateSeries",
        required: false
      }]
    }],
    chartReady: [{
      type: Output,
      args: ["chartReady"]
    }],
    chartElement: [{
      type: ViewChild,
      args: ["chart", {
        isSignal: true
      }]
    }]
  });
})();
var declarations = [ChartComponent];
var NgApexchartsModule = class _NgApexchartsModule {
  static {
    this.ɵfac = function NgApexchartsModule_Factory(__ngFactoryType__) {
      return new (__ngFactoryType__ || _NgApexchartsModule)();
    };
  }
  static {
    this.ɵmod = ɵɵdefineNgModule({
      type: _NgApexchartsModule,
      imports: [ChartComponent],
      exports: [ChartComponent]
    });
  }
  static {
    this.ɵinj = ɵɵdefineInjector({});
  }
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(NgApexchartsModule, [{
    type: NgModule,
    args: [{
      imports: [declarations],
      exports: [declarations]
    }]
  }], null, null);
})();
export {
  ChartComponent,
  NgApexchartsModule
};
//# sourceMappingURL=ng-apexcharts.js.map
