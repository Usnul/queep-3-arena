uniform sampler2D u_Texture0; 
uniform sampler2D u_Texture7; 
varying vec2 texture_coordinate;
varying vec2 texture_coordinate2;
varying vec2 texture_coordinate3;
varying vec2 texture_coordinate4;
varying vec2 texture_coordinate5;

void main()
{
	
    // Sampling The Texture And Passing It To The Frame Buffer 
   gl_FragColor = texture2D(u_Texture0, texture_coordinate); 
	
	if (abs(texture2D(u_Texture7, texture_coordinate).a-texture2D(u_Texture7, texture_coordinate2).a)>0.0016f) { gl_FragColor.r=0; gl_FragColor.g=0; gl_FragColor.b=0; }
	if (abs(texture2D(u_Texture7, texture_coordinate).a-texture2D(u_Texture7, texture_coordinate3).a)>0.0016f) { gl_FragColor.r=0; gl_FragColor.g=0; gl_FragColor.b=0; }
	if (abs(texture2D(u_Texture7, texture_coordinate).a-texture2D(u_Texture7, texture_coordinate4).a)>0.0016f) { gl_FragColor.r=0; gl_FragColor.g=0; gl_FragColor.b=0; }
	if (abs(texture2D(u_Texture7, texture_coordinate).a-texture2D(u_Texture7, texture_coordinate5).a)>0.0016f) { gl_FragColor.r=0; gl_FragColor.g=0; gl_FragColor.b=0; }

}	