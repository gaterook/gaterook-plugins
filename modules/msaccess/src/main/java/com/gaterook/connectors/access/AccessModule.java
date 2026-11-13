package com.gaterook.connectors.access;

import com.gaterook.connector.api.Connector;
import com.gaterook.connector.api.ConnectorModule;
import com.gaterook.connector.api.ModuleContext;
import java.util.List;

/**
 * The Microsoft Access connector as a connector module (docs/module-architecture.md): the entry point a module host
 * asks for its connectors. Microsoft Access exists only as a module: its code runs in a module host, in that host's
 * sandbox, and is never compiled into the core.
 */
public final class AccessModule implements ConnectorModule {

  @Override
  public List<Connector> connectors(ModuleContext context) {
    return List.of(new AccessConnector());
  }
}
