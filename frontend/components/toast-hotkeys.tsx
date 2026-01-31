'use client'

import { useEffect } from 'react'
import { toast } from '@/hooks/use-toast'

export function ToastHotkeys() {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!event.shiftKey) return
      if (event.code === 'F2') {
        event.preventDefault()
        toast({
          title: 'Success',
          description: 'Action completed successfully.',
          variant: 'success',
        })
      }
      if (event.code === 'F3') {
        event.preventDefault()
        toast({
          title: 'Alert',
          description: 'Please double-check the details.',
          variant: 'warning',
        })
      }
      if (event.code === 'F4') {
        event.preventDefault()
        toast({
          title: 'Failed',
          description: 'Something went wrong.',
          variant: 'destructive',
        })
      }
    }
    window.addEventListener('keydown', handler)
    return () => {
      window.removeEventListener('keydown', handler)
    }
  }, [])

  return null
}
