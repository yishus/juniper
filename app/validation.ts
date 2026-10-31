import { z } from 'zod'

// Initialize Zod before the auth/MCP SDKs, and avoid runtime code generation in Workers.
z.config({ jitless: true })
