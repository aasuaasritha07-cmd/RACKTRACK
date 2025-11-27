# RackTrack - AI-Powered Rack Auditing System

## Overview

RackTrack is a modern web application that leverages AI and computer vision to revolutionize infrastructure rack auditing. The system enables users to capture photos of server racks and automatically detect, catalog, and analyze equipment using advanced machine learning models. Built with a React frontend and Express backend, RackTrack provides real-time insights, predictive maintenance capabilities, and automated documentation for data center management.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework**: React 18 with TypeScript and Vite for fast development and building
- **UI Library**: Shadcn/ui components built on Radix UI primitives for accessible, modern interface
- **Styling**: Tailwind CSS with custom design system supporting dark mode themes
- **State Management**: TanStack Query for server state management and API caching
- **Routing**: Wouter for lightweight client-side routing
- **Component Structure**: Modular component architecture with reusable UI components and feature-specific sections

### Backend Architecture
- **Framework**: Express.js with TypeScript for type-safe server development
- **API Design**: RESTful API architecture with `/api` prefix for all endpoints
- **Error Handling**: Centralized error middleware with structured error responses
- **Development**: Hot module replacement and runtime error overlay for development experience

### Database Layer
- **ORM**: Drizzle ORM for type-safe database operations and schema management
- **Database**: PostgreSQL with Neon serverless hosting configured
- **Schema Management**: Code-first schema definition with automatic migrations
- **Storage Interface**: Abstracted storage layer supporting both in-memory (development) and persistent storage

### Authentication & Session Management
- **Session Storage**: PostgreSQL-based session store using connect-pg-simple
- **User Management**: Basic user schema with username/password authentication structure
- **Security**: Prepared for session-based authentication with secure cookie handling

### Development & Build System
- **Build Tool**: Vite for fast development and optimized production builds
- **TypeScript**: Full TypeScript support across frontend, backend, and shared modules
- **Code Quality**: ESBuild for production bundling and TypeScript compilation
- **Path Mapping**: Configured aliases for clean imports (@/, @shared/, @assets/)

### Design System
- **Color Palette**: Dark-mode first design with custom CSS variables for theming
- **Typography**: Inter font family with responsive text scaling
- **Component Variants**: Class Variance Authority for consistent component styling
- **Accessibility**: Built on Radix UI primitives ensuring WCAG compliance

## External Dependencies

### UI & Styling Dependencies
- **@radix-ui/**: Complete suite of accessible UI primitives (dialogs, dropdowns, forms, etc.)
- **tailwindcss**: Utility-first CSS framework with custom configuration
- **class-variance-authority**: Type-safe component variant handling
- **clsx**: Conditional CSS class utility

### Database & ORM
- **@neondatabase/serverless**: Neon PostgreSQL serverless driver
- **drizzle-orm**: Type-safe ORM with PostgreSQL dialect
- **drizzle-zod**: Zod integration for schema validation
- **connect-pg-simple**: PostgreSQL session store for Express

### Development Tools
- **vite**: Build tool and development server
- **tsx**: TypeScript execution for development
- **esbuild**: Fast JavaScript bundler for production
- **@replit/**: Replit-specific development plugins for enhanced debugging

### Form & Validation
- **react-hook-form**: Performant form library with minimal re-renders
- **@hookform/resolvers**: Validation resolvers for various schema libraries
- **zod**: TypeScript-first schema validation

### State Management & Data Fetching
- **@tanstack/react-query**: Server state management and caching
- **wouter**: Lightweight routing library for React

### Additional Features
- **date-fns**: Modern date utility library
- **embla-carousel-react**: Touch-friendly carousel component
- **cmdk**: Command palette interface component
- **lucide-react**: Modern icon library with React components