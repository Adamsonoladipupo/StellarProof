import React, { useState } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Modal,
  ModalHeader,
  ModalBody,
  ModalFooter,
} from "@/components/ui/Modal";
import { ToastProvider, useToast } from "@/context/ToastContext";
import Header from "@/components/Header";

// Replace framer-motion with plain elements so enter/exit animations
// cannot make these tests timing-dependent.
jest.mock("framer-motion", () => {
  const react = jest.requireActual("react");
  /* eslint-disable @typescript-eslint/no-unused-vars */
  const strip = (props: Record<string, unknown>) => {
    const {
      initial: _initial,
      animate: _animate,
      exit: _exit,
      transition: _transition,
      ...rest
    } = props;
    return rest;
    /* eslint-enable @typescript-eslint/no-unused-vars */
  };
  const cache: Record<string, unknown> = {};
  const motion = new Proxy(
    {},
    {
      get: (_target, tag) => {
        if (typeof tag !== "string") return undefined;
        if (!cache[tag]) {
          cache[tag] = react.forwardRef(
            (props: Record<string, unknown>, ref: unknown) =>
              react.createElement(tag, { ...strip(props), ref }),
          );
        }
        return cache[tag];
      },
    },
  );
  return {
    __esModule: true,
    motion,
    AnimatePresence: ({ children }: { children: unknown }) =>
      react.createElement(react.Fragment, null, children),
    useReducedMotion: () => false,
  };
});

describe("Modal", () => {
  const renderModal = (
    props: Partial<React.ComponentProps<typeof Modal>> = {},
  ) => {
    const onClose = jest.fn();
    const utils = render(
      <Modal open onClose={onClose} {...props}>
        <ModalHeader>Confirm action</ModalHeader>
        <ModalBody>
          <p>Are you sure?</p>
        </ModalBody>
        <ModalFooter>
          <button type="button">Cancel</button>
          <button type="button">Confirm</button>
        </ModalFooter>
      </Modal>,
    );
    return { onClose, ...utils };
  };

  it("renders nothing when closed", () => {
    renderModal({ open: false });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders the dialog and its content when open", () => {
    renderModal();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Are you sure?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument();
  });

  it("wires aria-labelledby and aria-describedby to header and body", () => {
    renderModal();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("Confirm action");
    expect(dialog).toHaveAccessibleDescription("Are you sure?");
  });

  it("applies the requested size class", () => {
    renderModal({ size: "sm" });
    expect(screen.getByRole("dialog")).toHaveClass("max-w-sm");
  });

  it("calls onClose when Escape is pressed", async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when the overlay is clicked", async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();
    await user.click(screen.getByRole("dialog").parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose when clicking inside the panel", async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();
    await user.click(screen.getByText("Are you sure?"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("moves focus to the first focusable element on open", () => {
    renderModal();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("traps focus: Tab from the last element wraps to the first", async () => {
    const user = userEvent.setup();
    renderModal();
    screen.getByRole("button", { name: "Confirm" }).focus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("traps focus: Shift+Tab from the first element wraps to the last", async () => {
    const user = userEvent.setup();
    renderModal();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Confirm" })).toHaveFocus();
  });

  it("locks body scroll while open and restores it on unmount", () => {
    const { unmount } = renderModal();
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open modal
          </button>
          <Modal open={open} onClose={() => setOpen(false)}>
            <ModalHeader>Title</ModalHeader>
            <ModalBody>
              <button type="button">Inside</button>
            </ModalBody>
          </Modal>
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open modal" });

    await user.click(trigger);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Inside" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("throws when a subcomponent is used outside Modal", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<ModalHeader>Orphan</ModalHeader>)).toThrow(
      /inside Modal/,
    );
    spy.mockRestore();
  });
});

describe("Toast", () => {
  let api = null as unknown as ReturnType<typeof useToast>;

  function Capture() {
    api = useToast();
    return null;
  }

  const renderToasts = () =>
    render(
      <ToastProvider>
        <Capture />
      </ToastProvider>,
    );

  const liveRegion = () =>
    document.querySelector('[aria-live="polite"]') as HTMLElement;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  it("throws when useToast is used outside a ToastProvider", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Capture />)).toThrow(/ToastProvider/);
    spy.mockRestore();
  });

  it("renders an empty polite live region initially", () => {
    renderToasts();
    expect(liveRegion()).toBeInTheDocument();
    expect(liveRegion()).toHaveAttribute("aria-atomic", "true");
    expect(liveRegion()).toBeEmptyDOMElement();
  });

  it("shows a toast message when addToast is called", () => {
    renderToasts();
    act(() => {
      api.addToast({ type: "success", message: "Saved successfully" });
    });
    expect(screen.getByText("Saved successfully")).toBeInTheDocument();
    expect(liveRegion()).toContainElement(
      screen.getByText("Saved successfully"),
    );
  });

  it.each([
    ["success", "bg-green-500"],
    ["error", "bg-red-500"],
    ["info", "bg-blue-500"],
    ["loading", "bg-gray-500"],
  ] as const)("styles a %s toast with %s", (type, expectedClass) => {
    renderToasts();
    act(() => {
      api.addToast({ type, message: `${type} message` });
    });
    const toast = screen.getByText(`${type} message`).closest("div.p-4");
    expect(toast).toHaveClass(expectedClass);
  });

  it("stacks multiple toasts", () => {
    renderToasts();
    act(() => {
      api.addToast({ type: "info", message: "First" });
      api.addToast({ type: "error", message: "Second" });
    });
    expect(screen.getByText("First")).toBeInTheDocument();
    expect(screen.getByText("Second")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "✕" })).toHaveLength(2);
  });

  it("dismisses only the toast whose close button is clicked", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    renderToasts();
    act(() => {
      api.addToast({ type: "info", message: "First" });
      api.addToast({ type: "error", message: "Second" });
    });
    await user.click(screen.getAllByRole("button", { name: "✕" })[0]);
    expect(screen.queryByText("First")).not.toBeInTheDocument();
    expect(screen.getByText("Second")).toBeInTheDocument();
  });

  it("auto-dismisses after the default 4000ms", () => {
    renderToasts();
    act(() => {
      api.addToast({ type: "info", message: "Temporary" });
    });
    act(() => {
      jest.advanceTimersByTime(3999);
    });
    expect(screen.getByText("Temporary")).toBeInTheDocument();
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(screen.queryByText("Temporary")).not.toBeInTheDocument();
  });

  it("respects a custom duration", () => {
    renderToasts();
    act(() => {
      api.addToast({ type: "info", message: "Quick", duration: 1000 });
    });
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(screen.queryByText("Quick")).not.toBeInTheDocument();
  });

  it("keeps a toast with duration Infinity until it is dismissed", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    renderToasts();
    act(() => {
      api.addToast({
        type: "loading",
        message: "Working...",
        duration: Infinity,
      });
    });
    act(() => {
      jest.advanceTimersByTime(60000);
    });
    expect(screen.getByText("Working...")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "✕" }));
    expect(screen.queryByText("Working...")).not.toBeInTheDocument();
  });

  it("removeToast is exposed and removes a toast programmatically", () => {
    renderToasts();
    act(() => {
      api.addToast({ type: "error", message: "Failed", duration: Infinity });
    });
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(typeof api.removeToast).toBe("function");
  });
});

// Header's children need wallet/theme providers and are not under test here.
jest.mock("@/components/WalletModal", () => ({
  __esModule: true,
  WalletModal: () =>
    jest.requireActual("react").createElement("div", { "data-testid": "wallet-modal" }),
}));
jest.mock("@/components/ThemeToggle", () => ({
  __esModule: true,
  default: () =>
    jest.requireActual("react").createElement("div", { "data-testid": "theme-toggle" }),
}));
jest.mock("@/components/wallet/NetworkBadge", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/wallet/WrongNetworkWarning", () => ({
  __esModule: true,
  default: () => null,
}));

describe("Header navigation (sidebar stand-in)", () => {
  let ioCallback = null as IntersectionObserverCallback | null;
  const observe = jest.fn();
  const disconnect = jest.fn();
  const scrollIntoView = jest.fn();
  const addedSections: HTMLElement[] = [];

  const addSection = (id: string) => {
    const el = document.createElement("div");
    el.id = id;
    document.body.appendChild(el);
    addedSections.push(el);
  };

  const mainNav = () => screen.getByRole("navigation", { name: "Main navigation" });
  const mobileDialog = () => screen.getByRole("dialog", { name: "Mobile navigation" });

  beforeEach(() => {
    ioCallback = null;
    observe.mockClear();
    disconnect.mockClear();
    scrollIntoView.mockClear();
    Element.prototype.scrollIntoView = scrollIntoView;
    (global as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
      jest.fn((cb: IntersectionObserverCallback) => {
        ioCallback = cb;
        return { observe, disconnect, unobserve: jest.fn() };
      });
  });

  afterEach(() => {
    addedSections.splice(0).forEach((el) => el.remove());
    Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
  });

  it("renders the logo link, desktop navigation and top-level links", () => {
    render(<Header />);
    expect(
      screen.getByRole("link", { name: "StellarProof — go to home" }),
    ).toBeInTheDocument();
    const nav = within(mainNav());
    expect(nav.getByRole("link", { name: "Home" })).toBeInTheDocument();
    expect(nav.getByRole("link", { name: "About" })).toBeInTheDocument();
    expect(nav.getByRole("link", { name: "Pricing" })).toBeInTheDocument();
    expect(nav.getByRole("button", { name: "Ecosystem" })).toBeInTheDocument();
    expect(screen.getByTestId("theme-toggle")).toBeInTheDocument();
    expect(screen.getAllByTestId("wallet-modal").length).toBeGreaterThan(0);
  });

  it("scrolls to the section and prevents default when a nav link is clicked", () => {
    addSection("about");
    render(<Header />);
    const link = within(mainNav()).getByRole("link", { name: "About" });
    const notPrevented = fireEvent.click(link);
    expect(notPrevented).toBe(false);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "start",
    });
  });

  it("marks Home active initially and moves the highlight when a section intersects", () => {
    addSection("about");
    render(<Header />);
    const nav = within(mainNav());
    expect(nav.getByRole("link", { name: "Home" })).toHaveClass("text-gray-900");
    expect(nav.getByRole("link", { name: "About" })).not.toHaveClass("text-gray-900");

    act(() => {
      ioCallback?.(
        [{ isIntersecting: true, target: { id: "about" } } as unknown as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });

    expect(nav.getByRole("link", { name: "About" })).toHaveClass("text-gray-900");
    expect(nav.getByRole("link", { name: "Home" })).not.toHaveClass("text-gray-900");
  });

  it("observes existing sections and disconnects on unmount", () => {
    addSection("pricing");
    const { unmount } = render(<Header />);
    expect(observe).toHaveBeenCalledTimes(1);
    unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("opens a desktop dropdown on hover and closes it on mouse leave", async () => {
    const user = userEvent.setup();
    render(<Header />);
    const button = within(mainNav()).getByRole("button", { name: "Ecosystem" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await user.hover(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Creator" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Developer" })).toBeInTheDocument();

    await user.unhover(button);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("scrolls and closes the dropdown when a hash menu item is clicked", async () => {
    const user = userEvent.setup();
    addSection("creator");
    render(<Header />);
    await user.hover(within(mainNav()).getByRole("button", { name: "Ecosystem" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Creator" }));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("keeps the mobile menu closed by default", () => {
    render(<Header />);
    expect(screen.queryByRole("dialog", { name: "Mobile navigation" })).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Open menu" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls", "mobile-menu");
  });

  it("toggles the mobile menu and updates the button label", async () => {
    const user = userEvent.setup();
    render(<Header />);
    await user.click(screen.getByRole("button", { name: "Open menu" }));
    expect(mobileDialog()).toBeInTheDocument();
    const closeBtn = screen.getByRole("button", { name: "Close menu" });
    expect(closeBtn).toHaveAttribute("aria-expanded", "true");

    await user.click(closeBtn);
    expect(screen.queryByRole("dialog", { name: "Mobile navigation" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open menu" })).toBeInTheDocument();
  });

  it("expands and collapses a mobile dropdown section", async () => {
    const user = userEvent.setup();
    render(<Header />);
    await user.click(screen.getByRole("button", { name: "Open menu" }));
    const section = within(mobileDialog()).getByRole("button", { name: /Ecosystem/ });
    expect(section).toHaveAttribute("aria-expanded", "false");

    await user.click(section);
    expect(section).toHaveAttribute("aria-expanded", "true");
    expect(within(mobileDialog()).getByRole("link", { name: "Creator" })).toBeInTheDocument();
    expect(within(mobileDialog()).getByRole("link", { name: "Developer" })).toBeInTheDocument();

    await user.click(section);
    expect(section).toHaveAttribute("aria-expanded", "false");
    expect(within(mobileDialog()).queryByRole("link", { name: "Creator" })).not.toBeInTheDocument();
  });

  it("closes the mobile menu and scrolls when a mobile link is clicked", async () => {
    const user = userEvent.setup();
    addSection("pricing");
    render(<Header />);
    await user.click(screen.getByRole("button", { name: "Open menu" }));
    await user.click(within(mobileDialog()).getByRole("link", { name: "Pricing" }));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "Mobile navigation" })).not.toBeInTheDocument();
  });

  it("applies the glass style only after scrolling", () => {
    render(<Header />);
    const header = screen.getByRole("banner");
    expect(header).not.toHaveClass("backdrop-blur-md");

    Object.defineProperty(window, "scrollY", { value: 50, configurable: true });
    act(() => {
      fireEvent.scroll(window);
    });
    expect(header).toHaveClass("backdrop-blur-md");
  });
});
