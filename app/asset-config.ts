// Shared by the Node development server and the Workers production build.
export const assetConfig = {
  basePath: '/assets',
  allowFiles: ['app/routes.ts', 'app/**/public/**'],
  allowPackages: ['remix'],
  denyFiles: ['app/**/*.test.*'],
}

export const browserEntry = 'app/actions/public/entry.ts'
