package com.example.hello;

import com.gaterook.connector.api.Connector;
import com.gaterook.connector.api.ConnectorModule;
import com.gaterook.connector.api.ModuleContext;
import java.util.List;

/**
 * The entry point of the module: module.json names this class as {@code moduleClass}. The module host makes one
 * instance with the public no-argument constructor and asks it once for its connectors, one per connector type.
 */
public final class HelloModule implements ConnectorModule {

  @Override
  public List<Connector> connectors(ModuleContext context) {
    return List.of(new HelloConnector(context.moduleVersion()));
  }
}
