/**
 * Central registry for all node type definitions
 */

import type { NodeDefinition } from './types'

/**
 * Global registry of all available node types
 */
class NodeRegistry {
  private nodes = new Map<string, NodeDefinition>()

  /**
   * Register a node definition
   * @param definition Node definition to register
   */
  register(definition: NodeDefinition): void {
    if (this.nodes.has(definition.type)) {
      console.warn(`Node type "${definition.type}" is already registered. Overwriting.`)
    }
    this.nodes.set(definition.type, definition)
  }

  /**
   * Register multiple node definitions
   * @param definitions Array of node definitions
   */
  registerMany(definitions: NodeDefinition[]): void {
    definitions.forEach((def) => this.register(def))
  }

  /**
   * Get a node definition by type
   * @param type Node type identifier
   * @returns Node definition or undefined if not found
   */
  get(type: string): NodeDefinition | undefined {
    return this.nodes.get(type)
  }

  /**
   * Get all registered node definitions
   * @returns Array of all node definitions
   */
  getAll(): NodeDefinition[] {
    return Array.from(this.nodes.values())
  }

  /**
   * Get all node definitions in a specific category
   * @param category Category name (e.g., "Noise", "Math")
   * @returns Array of matching node definitions
   */
  getByCategory(category: string): NodeDefinition[] {
    return this.getAll().filter((node) => node.category === category)
  }

  /**
   * Get all unique categories
   * @returns Array of category names
   */
  getCategories(): string[] {
    const categories = new Set<string>()
    this.nodes.forEach((node) => categories.add(node.category))
    return Array.from(categories).sort()
  }

  /**
   * Check if a node type exists
   * @param type Node type identifier
   * @returns True if node type is registered
   */
  has(type: string): boolean {
    return this.nodes.has(type)
  }

  /**
   * Clear all registered nodes (mainly for testing)
   */
  clear(): void {
    this.nodes.clear()
  }
}

/**
 * Singleton instance of the node registry
 */
export const nodeRegistry = new NodeRegistry()

/**
 * Helper function to register a node
 */
export function registerNode(definition: NodeDefinition): void {
  nodeRegistry.register(definition)
}

/**
 * Helper function to register multiple nodes
 */
export function registerNodes(definitions: NodeDefinition[]): void {
  nodeRegistry.registerMany(definitions)
}
