"use client";

import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";

export function CTASection() {
  return (
    <section className="py-24">
      <div className="container mx-auto px-4">
        <div className="max-w-4xl mx-auto text-center">
          {/* Badge */}
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-secondary border border-border mb-8">
            <span className="text-sm text-muted-foreground">Ready to start?</span>
          </div>

          {/* Heading */}
          <h2 className="text-3xl md:text-5xl font-bold text-foreground mb-6">
            Ready to make deals safer?
          </h2>
          <p className="text-lg text-muted-foreground mb-10 max-w-2xl mx-auto">
            For freelancers, teams, and businesses who need private terms with on-chain enforcement.
          </p>

          {/* CTAs */}
          <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
            <Button size="lg" className="bg-accent text-accent-foreground hover:bg-accent/90 group">
              Launch App
              <ArrowRight className="ml-2 w-4 h-4 group-hover:translate-x-1 transition-transform" />
            </Button>
            <Button size="lg" variant="outline" className="border-border hover:bg-secondary bg-transparent">
              Read Docs
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
