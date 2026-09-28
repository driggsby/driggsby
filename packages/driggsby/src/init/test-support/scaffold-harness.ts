// The scaffold test harness: runs the scaffolded app.js against a DOM stub
// just wide enough to observe what it painted. Shared by the scaffold's
// test files; test-support is left out of the published build.
import { runInNewContext } from "node:vm";

import { APP_JS } from "../templates.ts";

// A DOM stub just wide enough to execute the scaffold's app.js and observe
// what it painted, so the no-flash invariant is tested behaviorally: sample
// numbers exist in the DOM only when the page is genuinely standalone.
export class StubNode {
  className = "";
  textContent = "";
  children: StubNode[] = [];
  attributes = new Map<string, string>();
  parent: StubNode | null = null;
  // Inline custom properties the scaffold sets, by name.
  styles = new Map<string, string>();
  style = {
    setProperty: (name: string, value: string): void => {
      this.styles.set(name, value);
    },
  };

  append(...nodes: StubNode[]): void {
    for (const node of nodes) node.parent = this;
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: StubNode[]): void {
    for (const node of nodes) node.parent = this;
    this.children = nodes;
  }

  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }

  // Only the one shape the scaffold asks for: a class among the children.
  querySelector(selector: string): StubNode | null {
    const className = selector.replace(/^\./, "");
    return this.children.find((child) => child.className.split(" ").includes(className)) ?? null;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
}

export interface ScaffoldRun {
  overview: StubNode;
  accounts: StubNode;
  overviewSkeleton: StubNode[];
  accountsSkeleton: StubNode[];
  watches: Map<string, (result: unknown) => void>;
  // Each watch's onError, by tool: how a test fails a call.
  errorHandlers: Map<string, (error: unknown) => void>;
  // Captured, never run on their own: a test drives the settle beat and
  // the dissolve by invoking these in order.
  transitions: (() => void)[];
  timers: (() => void)[];
  // Everything the scaffold reported via console.error.
  errors: unknown[];
}

// Mirrors the shipped HTML: the containers start marked busy and holding
// their skeleton children (4 stat bars, 3 account rows), so the assertions
// about replacement are about a skeleton that was genuinely there.
function skeletonNodes(count: number): StubNode[] {
  return Array.from({ length: count }, () => {
    const node = new StubNode();
    node.className = "skeleton";
    return node;
  });
}

export function runScaffoldAppJs(options: {
  embedded: boolean;
  sdkLoaded: boolean;
  // Gives the stub document a startViewTransition and the context a
  // captured setTimeout, the two things the scaffold's settle path needs;
  // without them the scaffold paints synchronously, as in old browsers.
  viewTransitions?: boolean;
  // With viewTransitions, makes the stubbed matchMedia report reduced
  // motion, which must route the first paint around the dissolve.
  reducedMotion?: boolean;
}): ScaffoldRun {
  const overview = new StubNode();
  const accounts = new StubNode();
  const overviewSkeleton = skeletonNodes(4);
  const accountsSkeleton = skeletonNodes(3);
  overview.children = [...overviewSkeleton];
  accounts.children = [...accountsSkeleton];
  overview.attributes.set("aria-busy", "true");
  accounts.attributes.set("aria-busy", "true");
  const byId = new Map<string, StubNode>([
    ["overview", overview],
    ["accounts", accounts],
  ]);
  const watches = new Map<string, (result: unknown) => void>();
  const errorHandlers = new Map<string, (error: unknown) => void>();
  const transitions: (() => void)[] = [];
  const timers: (() => void)[] = [];
  const errors: unknown[] = [];
  const documentStub: {
    getElementById: (id: string) => StubNode | null;
    createElement: () => StubNode;
    startViewTransition?: (update: () => void) => { ready: Promise<never> };
  } = {
    getElementById: (id: string): StubNode | null => byId.get(id) ?? null,
    createElement: (): StubNode => new StubNode(),
  };
  if (options.viewTransitions) {
    documentStub.startViewTransition = (update: () => void): { ready: Promise<never> } => {
      transitions.push(update);
      // Never settles, like a transition whose animation is still running;
      // the scaffold only attaches a rejection handler to it.
      return { ready: new Promise<never>(() => undefined) };
    };
  }
  const driggsbyStub = options.sdkLoaded
    ? {
        watch: (
          tool: string,
          _params: Record<string, unknown>,
          callback: (result: unknown) => void,
          watchOptions?: { onError?: unknown },
        ): (() => void) => {
          watches.set(tool, callback);
          const onError = watchOptions?.onError;
          if (isErrorHandler(onError)) errorHandlers.set(tool, onError);
          return () => undefined;
        },
      }
    : undefined;
  const windowStub: {
    parent: unknown;
    driggsby?: typeof driggsbyStub;
    matchMedia?: (query: string) => { matches: boolean };
  } = { parent: null };
  windowStub.parent = options.embedded ? {} : windowStub;
  if (driggsbyStub) windowStub.driggsby = driggsbyStub;
  const context: Record<string, unknown> = {
    window: windowStub,
    document: documentStub,
    driggsby: driggsbyStub,
    // A fresh vm context has no console; the scaffold reports a throwing
    // render through console.error, and tests read it back via `errors`.
    console: {
      error: (...args: unknown[]): void => {
        errors.push(args);
      },
    },
  };
  if (options.viewTransitions) {
    windowStub.matchMedia = (): { matches: boolean } => ({
      matches: options.reducedMotion === true,
    });
    context.setTimeout = (callback: () => void): void => {
      timers.push(callback);
    };
  }
  runInNewContext(APP_JS, context);
  return {
    overview,
    accounts,
    overviewSkeleton,
    accountsSkeleton,
    watches,
    errorHandlers,
    transitions,
    timers,
    errors,
  };
}

function isErrorHandler(value: unknown): value is (error: unknown) => void {
  return typeof value === "function";
}

export function holdsNoSkeleton(container: StubNode, skeleton: StubNode[]): boolean {
  return container.children.every((child) => !skeleton.includes(child));
}
