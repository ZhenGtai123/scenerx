/**
 * ErrorBoundary — last-line-of-defense against white screens.
 *
 * Why this exists: chart components (Recharts custom renderers, archetype
 * label paths, etc.) can throw on undefined access during state transitions
 * — panorama view switches, multi-view cluster loops, hydration races. Each
 * throw site is plugged with a null-guard, but a single missed access still
 * white-screens the entire Reports page. This boundary wraps the danger
 * zones so a crash collapses to a recoverable inline panel instead of an
 * empty page.
 *
 * Usage:
 *   <ErrorBoundary label="Analysis charts">
 *     <AnalysisCharts ... />
 *   </ErrorBoundary>
 *
 * On error it shows the error message + a "Reload page" button. The user
 * can also click "Try to recover" which resets the boundary state — useful
 * when the underlying state has been fixed (e.g. they switched panorama
 * view and the data is now valid).
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Alert, AlertIcon, AlertTitle, AlertDescription, Box, Button, HStack, Code } from '@chakra-ui/react';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Short label shown in the error alert, e.g. "Analysis charts". */
  label?: string;
  /** Optional fallback override. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Log to console so the error is preserved + stack trace visible. The
    // alert UI surfaces a truncated message; the full stack is in DevTools.
    console.error('[ErrorBoundary]', this.props.label ?? 'unlabeled', error, info.componentStack);
  }

  reset = () => {
    this.setState({ error: null });
  };

  reload = () => {
    if (typeof window !== 'undefined') window.location.reload();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);

    const label = this.props.label ?? 'this section';
    return (
      <Box p={4}>
        <Alert status="error" borderRadius="md" alignItems="flex-start" flexDir="column">
          <HStack align="flex-start" w="full">
            <AlertIcon mt={1} />
            <Box flex="1">
              <AlertTitle>Something went wrong in {label}</AlertTitle>
              <AlertDescription display="block" mt={2}>
                A render crash prevented {label} from displaying. The rest of
                the page is unaffected. Click "Try to recover" to re-mount
                this section after the underlying state changes (e.g.
                switching panorama view, re-running clustering), or reload
                the page if the error keeps repeating.
              </AlertDescription>
              <Code mt={3} p={2} fontSize="xs" colorScheme="red" w="full" whiteSpace="pre-wrap">
                {error.message}
              </Code>
              <HStack mt={3} spacing={2}>
                <Button size="sm" colorScheme="red" variant="outline" onClick={this.reset}>
                  Try to recover
                </Button>
                <Button size="sm" colorScheme="red" onClick={this.reload}>
                  Reload page
                </Button>
              </HStack>
            </Box>
          </HStack>
        </Alert>
      </Box>
    );
  }
}

export default ErrorBoundary;
