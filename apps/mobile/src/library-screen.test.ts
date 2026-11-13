import { beforeEach, describe, expect, it, vi } from "vitest";
import { Children, isValidElement, type ReactElement } from "react";

const ui = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0, pick: vi.fn(), importEpisode: vi.fn(), list: vi.fn() }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useCallback: (callback: unknown) => callback, useState: (initial: unknown) => {
    const index = ui.cursor++;
    if (!(index in ui.states)) ui.states[index] = initial;
    return [ui.states[index], (value: unknown) => { ui.states[index] = value; }];
  } };
});
vi.mock("react-native", () => ({ Button: "Button", SafeAreaView: "SafeAreaView", ScrollView: "ScrollView", Text: "Text" }));
vi.mock("expo-router", () => ({ useFocusEffect: () => {}, useRouter: () => ({ push: vi.fn(), navigate: vi.fn() }) }));
vi.mock("expo-sqlite/kv-store", () => ({ default: {} }));
vi.mock("expo-file-system", () => ({ File: { pickFileAsync: ui.pick } }));
vi.mock("./offline-files", () => ({ importUsbEpisode: ui.importEpisode, listOfflineEpisodes: ui.list }));

import Library from "../app/library";

type Node = ReactElement<{ children?: React.ReactNode; title?: string; disabled?: boolean; onPress?: () => Promise<void>; accessibilityLiveRegion?: string; style?: { flex?: number } }>;
function render() { ui.cursor = 0; return Library() as Node; }
function nodes(element: Node): Node[] {
  return [element, ...Children.toArray(element.props.children).filter(isValidElement).flatMap((child) => nodes(child as Node))];
}
function button(tree: Node, title: string) { return nodes(tree).find((node) => node.props.title === title)!; }
function text(tree: Node) { return nodes(tree).flatMap((node) => typeof node.props.children === "string" ? [node.props.children] : []); }

beforeEach(() => { ui.states = []; ui.cursor = 0; vi.clearAllMocks(); });

describe("Library", () => {
  it("puts offline episode controls in a bounded scroll view", () => {
    ui.states[2] = [{ id: "one", title: "First" }, { id: "two", title: "Last" }];
    const tree = render();
    const scroll = nodes(tree).find((node) => node.type === "ScrollView");
    expect(tree.props.style?.flex).toBe(1);
    expect(scroll).toBeDefined();
    expect(button(scroll!, "Last • offline")).toBeDefined();
  });

  it("replaces the picker instruction with a live copying and verification message while import is pending", async () => {
    let finish!: (value: { title: string }) => void;
    ui.pick.mockResolvedValueOnce({ canceled: false, result: {} }).mockResolvedValueOnce({ canceled: false, result: {} });
    ui.importEpisode.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    ui.list.mockResolvedValue([]);
    const pending = button(render(), "Import USB package").props.onPress!();
    await vi.waitFor(() => expect(ui.importEpisode).toHaveBeenCalled());
    const busy = render();
    expect(button(busy, "Import USB package").props.disabled).toBe(true);
    expect(text(busy)).toContain("Copying and verifying package. This may take a while.");
    expect(text(busy)).not.toContain("Now select audio.m4a from the same trusted package.");
    expect(nodes(busy).find((node) => node.props.accessibilityLiveRegion === "polite")?.props.children).toBe("Copying and verifying package. This may take a while.");
    finish({ title: "Episode" });
    await pending;
    const done = render();
    expect(text(done)).toContain("Imported Episode.");
    expect(button(done, "Import USB package").props.disabled).toBe(false);
  });

  it.each([true, false])("re-enables import after cancelling a picker (metadata: %s)", async (metadata) => {
    if (!metadata) ui.pick.mockResolvedValueOnce({ canceled: false, result: {} });
    ui.pick.mockResolvedValueOnce({ canceled: true });
    await button(render(), "Import USB package").props.onPress!();
    expect(button(render(), "Import USB package").props.disabled).toBe(false);
    expect(ui.importEpisode).not.toHaveBeenCalled();
  });

  it("shows import failures and allows retry", async () => {
    ui.pick.mockResolvedValue({ canceled: false, result: {} });
    ui.importEpisode.mockRejectedValue(new Error("bad audio"));
    await button(render(), "Import USB package").props.onPress!();
    const tree = render();
    expect(text(tree)).toContain("Import failed: bad audio");
    expect(button(tree, "Import USB package").props.disabled).toBe(false);
  });
});
