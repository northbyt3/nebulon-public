"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Menu, X, Wallet } from "lucide-react";

const navItems = [
  { label: "Home", href: "#" },
  { label: "How It Works", href: "#how-it-works" },
  { label: "Features", href: "#features" },
  { label: "Trust", href: "#trust" },
];

export function Header() {
  const [isScrolled, setIsScrolled] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 20);
    };
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <header
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        isScrolled
          ? "bg-background/95 backdrop-blur-xl border-b border-border/50 shadow-lg"
          : "bg-transparent"
      }`}
    >
      <div className="container mx-auto px-4 md:px-6">
        <div className="relative flex items-center justify-between h-16 md:h-20">
          {/* Logo */}
          <Link 
            href="/" 
            className="text-xl md:text-2xl font-bold text-foreground hover:text-accent transition-colors relative group z-10"
          >
            <span className="relative z-10">Nebulon</span>
            {!isScrolled && (
              <span className="absolute inset-0 bg-accent/10 blur-xl opacity-0 group-hover:opacity-100 transition-opacity -z-10" />
            )}
          </Link>

          {/* Desktop Navigation - Centered */}
          <nav className="hidden md:flex items-center gap-6 lg:gap-8 absolute left-1/2 -translate-x-1/2">
            {navItems.map((item) => (
              <Link
                key={item.label}
                href={item.href}
                className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors relative group"
              >
                {item.label}
                <span className="absolute bottom-0 left-0 w-0 h-0.5 bg-accent group-hover:w-full transition-all duration-300" />
              </Link>
            ))}
          </nav>

          {/* CTA */}
          <div className="hidden md:flex items-center gap-3 z-10">
            <Button 
              variant="ghost" 
              className="text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/50"
            >
              Documentation
            </Button>
            <Button 
              className="bg-accent text-accent-foreground hover:bg-accent/90 shadow-lg shadow-accent/20 hover:shadow-accent/30 transition-all duration-300 group"
            >
              <Wallet className="w-4 h-4 mr-2 group-hover:scale-110 transition-transform" />
              Connect Wallet
            </Button>
          </div>

          {/* Mobile Menu Button */}
          <button
            className="md:hidden p-2 text-foreground hover:text-accent transition-colors rounded-md hover:bg-secondary/50"
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            aria-label="Toggle menu"
          >
            {isMobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </div>

        {/* Mobile Menu */}
        {isMobileMenuOpen && (
          <div className="md:hidden py-4 border-t border-border bg-background/95 backdrop-blur-xl">
            <nav className="flex flex-col gap-2">
              {navItems.map((item) => (
                <Link
                  key={item.label}
                  href={item.href}
                  className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors py-2 px-2 rounded-md hover:bg-secondary/50"
                  onClick={() => setIsMobileMenuOpen(false)}
                >
                  {item.label}
                </Link>
              ))}
              <div className="flex flex-col gap-2 mt-2 pt-2 border-t border-border">
                <Button 
                  variant="ghost" 
                  className="justify-start text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                >
                  Documentation
                </Button>
                <Button 
                  className="bg-accent text-accent-foreground hover:bg-accent/90 shadow-lg shadow-accent/20 justify-start group"
                >
                  <Wallet className="w-4 h-4 mr-2 group-hover:scale-110 transition-transform" />
                  Connect Wallet
                </Button>
              </div>
            </nav>
          </div>
        )}
      </div>
    </header>
  );
}
