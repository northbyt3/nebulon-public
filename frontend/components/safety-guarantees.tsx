"use client";

import { Shield, Lock, Eye, Scale, Clock, Users } from "lucide-react";

export function SafetyGuarantees() {
  return (
    <section className="py-16 bg-secondary/20">
      <div className="container mx-auto px-4">
        {/* Section header */}
        <div className="text-center mb-12">
          <h2 className="text-2xl md:text-3xl font-bold text-foreground mb-2">
            Safety Guarantees
          </h2>
          <p className="text-muted-foreground max-w-xl mx-auto">
            Built-in protections for both clients and contractors
          </p>
        </div>

        {/* Guarantees grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-6xl mx-auto">
          <div className="text-center p-6 rounded-lg bg-card border border-border hover:border-accent/50 transition-colors">
            <div className="w-12 h-12 rounded-xl bg-accent/10 flex items-center justify-center mb-4 mx-auto">
              <Shield className="w-6 h-6 text-accent" />
            </div>
            <div className="text-lg font-semibold text-foreground mb-2">Client Safety</div>
            <div className="text-sm text-muted-foreground leading-relaxed">
              Funds only move when milestones are approved. No partial payouts until all work is complete. Timeout refunds available if deadlines pass.
            </div>
          </div>

          <div className="text-center p-6 rounded-lg bg-card border border-border hover:border-accent/50 transition-colors">
            <div className="w-12 h-12 rounded-xl bg-accent/10 flex items-center justify-center mb-4 mx-auto">
              <Lock className="w-6 h-6 text-accent" />
            </div>
            <div className="text-lg font-semibold text-foreground mb-2">Contractor Safety</div>
            <div className="text-sm text-muted-foreground leading-relaxed">
              Funds are locked upfront in the escrow program account (PDA). No "I'll pay later" promises—payment is secured on-chain before work starts.
            </div>
          </div>

          <div className="text-center p-6 rounded-lg bg-card border border-border hover:border-accent/50 transition-colors">
            <div className="w-12 h-12 rounded-xl bg-accent/10 flex items-center justify-center mb-4 mx-auto">
              <Eye className="w-6 h-6 text-accent" />
            </div>
            <div className="text-lg font-semibold text-foreground mb-2">Privacy</div>
            <div className="text-sm text-muted-foreground leading-relaxed">
              Terms and milestone details are stored privately in MagicBlock PER. Only authorized parties can read or update them.
            </div>
          </div>

          <div className="text-center p-6 rounded-lg bg-card border border-border hover:border-accent/50 transition-colors">
            <div className="w-12 h-12 rounded-xl bg-accent/10 flex items-center justify-center mb-4 mx-auto">
              <Scale className="w-6 h-6 text-accent" />
            </div>
            <div className="text-lg font-semibold text-foreground mb-2">Dispute Resolution</div>
            <div className="text-sm text-muted-foreground leading-relaxed">
              On-chain judge resolves disputes according to program rules. Available while work is in progress, before all milestones are approved.
            </div>
          </div>

          <div className="text-center p-6 rounded-lg bg-card border border-border hover:border-accent/50 transition-colors">
            <div className="w-12 h-12 rounded-xl bg-accent/10 flex items-center justify-center mb-4 mx-auto">
              <Clock className="w-6 h-6 text-accent" />
            </div>
            <div className="text-lg font-semibold text-foreground mb-2">Timeout Protection</div>
            <div className="text-sm text-muted-foreground leading-relaxed">
              If deadlines expire without completion, clients can claim automatic refunds. Mutual cancel option available by agreement.
            </div>
          </div>

          <div className="text-center p-6 rounded-lg bg-card border border-border hover:border-accent/50 transition-colors">
            <div className="w-12 h-12 rounded-xl bg-accent/10 flex items-center justify-center mb-4 mx-auto">
              <Users className="w-6 h-6 text-accent" />
            </div>
            <div className="text-lg font-semibold text-foreground mb-2">Non-Custodial</div>
            <div className="text-sm text-muted-foreground leading-relaxed">
              Funds are held by the escrow program account (PDA), not by a company. You maintain control—no third-party custody risks.
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
