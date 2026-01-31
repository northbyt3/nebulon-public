'use client'

import { useToast } from '@/hooks/use-toast'
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from '@/components/ui/toast'
import { CheckCircle2, AlertTriangle, Info, XCircle } from 'lucide-react'

export function Toaster() {
  const { toasts } = useToast()

  const iconFor = (variant?: string) => {
    switch (variant) {
      case 'success':
        return <CheckCircle2 className="h-4 w-4 text-emerald-300" />
      case 'warning':
        return <AlertTriangle className="h-4 w-4 text-amber-300" />
      case 'destructive':
        return <XCircle className="h-4 w-4 text-rose-300" />
      default:
        return <Info className="h-4 w-4 text-[#a08bff]" />
    }
  }

  return (
    <ToastProvider>
      {toasts.map(function ({ id, title, description, action, ...props }) {
        return (
          <Toast key={id} {...props}>
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-full bg-white/5">
                {iconFor(props.variant)}
              </div>
              <div className="grid gap-1">
                {title && <ToastTitle>{title}</ToastTitle>}
                {description && (
                  <ToastDescription>{description}</ToastDescription>
                )}
              </div>
            </div>
            {action}
            <ToastClose />
          </Toast>
        )
      })}
      <ToastViewport />
    </ToastProvider>
  )
}
