// Explicit dependency injection for unit tests; production never disables tracing.
export const fakeTraceFactory=()=>({state:{phase:'initial_wait',additionalWaits:0,imageCalls:0},async start(){},async flush(){},async stop(){},returnedImage(){}});
