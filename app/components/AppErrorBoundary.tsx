import { Component, type ReactNode } from "react";
import { Banner, BlockStack, Text, Button, Card } from "@shopify/polaris";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * React class-based Error Boundary for catching render errors
 * in child components without crashing the entire page layout.
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[AppErrorBoundary]", error, info.componentStack);
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <Card>
          <BlockStack gap="300">
            <Banner tone="critical" title="Something went wrong">
              <p>An unexpected error occurred. You can try again or reload the page.</p>
            </Banner>
            {process.env.NODE_ENV === "development" && this.state.error && (
              <Text as="p" variant="bodySm" tone="subdued">
                {this.state.error.message}
              </Text>
            )}
            <Button onClick={this.handleRetry}>Try again</Button>
          </BlockStack>
        </Card>
      );
    }

    return this.props.children;
  }
}
