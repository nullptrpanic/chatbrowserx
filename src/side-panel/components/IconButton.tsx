import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly label: string;
  readonly children: ReactNode;
}

/** Renders a native icon button with a stable accessible label and tooltip. */
export function IconButton({ label, children, className = '', ...props }: IconButtonProps) {
  return (
    <button
      {...props}
      type={props.type ?? 'button'}
      className={`icon-button ${className}`.trim()}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}
