import { forwardRef, InputHTMLAttributes } from "react";

type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className = "", ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={`
        w-full h-12 px-4
        bg-surface border border-border rounded-md
        text-foreground placeholder:text-muted-2
        font-mono text-sm
        transition-colors
        hover:border-border-strong
        focus:border-accent focus:outline-none
        ${className}
      `}
      {...props}
    />
  );
});
