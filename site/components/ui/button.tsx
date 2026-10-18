import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

// shadcn-style API with non-default styling: square-ish 2px corners, no shadows, no gradients.
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4a9eff] focus-visible:ring-offset-2 focus-visible:ring-offset-page',
  {
    variants: {
      variant: {
        primary: 'rounded-[2px] bg-heading text-page hover:bg-white',
        link: 'text-body underline decoration-[#4a4a50] underline-offset-[6px] hover:text-heading hover:decoration-heading'
      },
      size: {
        default: 'h-11 px-5 text-[15px]',
        inline: 'h-11 text-[15px]'
      }
    },
    defaultVariants: { variant: 'primary', size: 'default' }
  }
)

export interface ButtonLinkProps
  extends React.AnchorHTMLAttributes<HTMLAnchorElement>,
    VariantProps<typeof buttonVariants> {}

// Every call to action on this site navigates, so the button renders as a link.
export const ButtonLink = React.forwardRef<HTMLAnchorElement, ButtonLinkProps>(
  ({ className, variant, size, ...props }, ref) => (
    <a ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />
  )
)
ButtonLink.displayName = 'ButtonLink'

export { buttonVariants }
