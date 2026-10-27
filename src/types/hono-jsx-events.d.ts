// WORKAROUND: hono/jsx's intrinsic-element types (hono 4.13.14) name browser event types for client-side handler
// props, and the Workers runtime types (worker-configuration.d.ts) do not declare them; adding the DOM library instead
// conflicts with the runtime types in over 170 declarations. Server rendering never calls these handlers, so each is
// declared here as the runtime's own Event, keeping library checks on everywhere else. Remove when hono's JSX types
// stop requiring the DOM library.
interface AnimationEvent extends Event {}
interface ClipboardEvent extends Event {}
interface CompositionEvent extends Event {}
interface DragEvent extends Event {}
interface FocusEvent extends Event {}
interface FormDataEvent extends Event {}
interface InputEvent extends Event {}
interface KeyboardEvent extends Event {}
interface MouseEvent extends Event {}
interface PointerEvent extends Event {}
interface TouchEvent extends Event {}
interface TransitionEvent extends Event {}
interface WheelEvent extends Event {}
